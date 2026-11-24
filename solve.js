// Faster drop-in for makefun-site 1.0.0. run(input) returns the same output tree.
// Hot path: Markdown inline (batched HTML escape), word counts, template render with
// reuse of partials that only read site-wide values.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const CONST_VARS = new Set(['site', 'tags', 'recent']);

const ESCAPABLE_CODE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE_CODE[ch.charCodeAt(0)] = 1;
}

function isWsRare(c) {
  return c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160 || (c > 127 && isWsRare(c));
}

function hasWsRange(s, from, to) {
  for (let i = from; i < to; i++) if (isWs(s.charCodeAt(i))) return true;
  return false;
}

function pushEscaped(parts, s, from, to) {
  let start = from;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (i > start) parts.push(s.slice(start, i));
    parts.push(rep);
    start = i + 1;
  }
  if (start === from) parts.push(from === 0 && to === s.length ? s : s.slice(from, to));
  else if (start < to) parts.push(s.slice(start, to));
}

function escapeHtml(text) {
  const n = text.length;
  let i = 0;
  for (; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
  }
  if (i === n) return text;
  const parts = [];
  pushEscaped(parts, text, 0, n);
  return parts.length === 1 ? parts[0] : parts.join('');
}

let slugCache = null;

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  if (taken.has(out)) {
    let n = 2;
    do {
      out = slug + '-' + n;
      n++;
    } while (taken.has(out));
  }
  taken.add(out);
  return out;
}

function longDate(date) {
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  return d + ' ' + MONTHS[m - 1] + ' ' + date.slice(0, 4);
}

function wordCount(text) {
  let n = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    const sp = c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 11 || c === 160 || (c > 127 && isWsRare(c));
    if (sp) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const n = raw.length;
    if (n < 2 || raw.charCodeAt(n - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < n - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === n - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
      const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return raw.length === 0 ? { error: 'key "layout": not a template name' } : { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevHyphen = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevHyphen = false;
        else if (c === 45 && !prevHyphen) prevHyphen = true;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevHyphen) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function parseFrontMatter(text) {
  const n = text.length;
  if (n < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (n !== 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  if (n === 3) return { error: 'the front matter is not closed' };
  const data = {};
  let i = 4;
  let lineIndex = 1;
  while (i <= n) {
    let end = text.indexOf('\n', i);
    const last = end === -1;
    if (last) end = n;
    if (end - i === 3 && text.charCodeAt(i) === 45 && text.charCodeAt(i + 1) === 45 && text.charCodeAt(i + 2) === 45) {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: last ? '' : text.slice(end + 1) };
    }
    let blank = true;
    for (let k = i; k < end; k++) {
      const c = text.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && text.charCodeAt(i) !== 35) {
      let colon = -1;
      for (let k = i; k < end; k++) {
        const c = text.charCodeAt(k);
        if (c === 58) {
          colon = k;
          break;
        }
        if (!((c >= 97 && c <= 122) || c === 95)) {
          colon = -2;
          break;
        }
      }
      if (colon <= i) return { error: 'line ' + (lineIndex + 1) + ' is not "key: value"' };
      if (colon !== end - 1 && text.charCodeAt(colon + 1) !== 32) return { error: 'line ' + (lineIndex + 1) + ' is not "key: value"' };
      const key = text.slice(i, colon);
      const rawStart = colon + 1 < end ? colon + 2 : end;
      let rawEnd = end;
      while (rawEnd > rawStart) {
        const c = text.charCodeAt(rawEnd - 1);
        if (c !== 32 && c !== 9) break;
        rawEnd--;
      }
      const raw = text.slice(rawStart, rawEnd);
      if (!KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    lineIndex++;
    if (last) break;
    i = end + 1;
  }
  return { error: 'the front matter is not closed' };
}

// ---------------------------------------------------------------- markdown

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  if (a === 0 && b === line.length) return line;
  return line.slice(a, b);
}

/** Fence language, or null when the line is not a fence open. */
function fenceLang(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return line.slice(3, langEnd);
}

function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingInfo(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let hashes = 1;
  const n = line.length;
  while (hashes < n && hashes < 6 && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === n) return null;
  if (line.charCodeAt(hashes) !== 32 && line.charCodeAt(hashes) !== 9) return null;
  let i = hashes;
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = n;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth: hashes, text: line.slice(i, end) };
}

function isHr(line) {
  let kind = 0;
  if (line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) kind = 3;
  else if (line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42) kind = 3;
  else return false;
  for (let i = kind; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9 && c !== 35 && c !== 96 && c !== 45 && c !== 42) return line.length === 0;
  return isBlank(line) || fenceLang(line) !== null || headingInfo(line) !== null || isHr(line);
}

function bulletRest(line) {
  if (line.length >= 2 && (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedInfo(line) {
  const n = line.length;
  let i = 0;
  while (i < n && i < 9) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i + 1 >= n || line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  let num = 0;
  for (let k = 0; k < i; k++) num = num * 10 + (line.charCodeAt(k) - 48);
  return { start: num, rest: line.slice(i + 2) };
}

function isContinued(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < n && line.charCodeAt(i) === 32) i++;
  if (i >= n) return false;
  return !isWs(line.charCodeAt(i));
}

function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push(1, lang, body);
      continue;
    }
    const heading = headingInfo(line);
    if (heading !== null) {
      tokens.push(2, heading.depth, heading.text);
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push(3);
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const q = lines[i++];
        const stripped = q.length > 1 && q.charCodeAt(1) === 32 ? q.slice(2) : q.slice(1);
        const trimmed = trimLine(stripped);
        if (trimmed !== '') body.push(trimmed);
      }
      tokens.push(4, body);
      continue;
    }
    const bullet = bulletRest(line);
    const ordered = bullet === null ? orderedInfo(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.start : 1;
      const items = [];
      while (i < n) {
        const cur = lines[i];
        if (isOrdered) {
          const o = orderedInfo(cur);
          if (o !== null) {
            items.push(trimLine(o.rest));
            i++;
            continue;
          }
        } else {
          const b = bulletRest(cur);
          if (b !== null) {
            items.push(trimLine(b));
            i++;
            continue;
          }
        }
        if (items.length > 0 && isContinued(cur)) {
          const prev = items[items.length - 1];
          items[items.length - 1] = prev + '\n' + trimLine(cur);
          i++;
          continue;
        }
        break;
      }
      tokens.push(5, isOrdered, start, items);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push(6, body.join('\n'));
  }
  return tokens;
}

function findDoubleStar(s, from, end) {
  for (let j = from; j <= end - 2; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE_CODE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE_CODE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function findUnescapedByte(s, code, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE_CODE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c === code) return j;
  }
  return -1;
}

const SPECIAL = /[&<>"'\\`*\[]/g;

function flushPlain(parts, s, plain, i) {
  if (i > plain) parts.push(plain === 0 && i === s.length ? s : s.slice(plain, i));
}

function inlineInto(parts, s, from, to, env) {
  let plain = from;
  SPECIAL.lastIndex = from;
  while (true) {
    const m = SPECIAL.exec(s);
    const i = m === null || m.index >= to ? to : m.index;
    if (i >= to) {
      if (plain < to) parts.push(plain === 0 && to === s.length ? s : s.slice(plain, to));
      return;
    }
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      flushPlain(parts, s, plain, i);
      parts.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      plain = i + 1;
      continue;
    }
    if (c === 92) {
      if (i + 1 < to && ESCAPABLE_CODE[s.charCodeAt(i + 1)]) {
        flushPlain(parts, s, plain, i);
        plain = i + 1;
        SPECIAL.lastIndex = i + 2;
      }
      continue;
    }
    if (c === 96) {
      let j = s.indexOf('`', i + 1);
      if (j < 0 || j >= to) j = -1;
      if (j > i + 1) {
        flushPlain(parts, s, plain, i);
        parts.push('<code>');
        pushEscaped(parts, s, i + 1, j);
        parts.push('</code>');
        plain = j + 1;
        SPECIAL.lastIndex = plain;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < to && s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2, to);
        if (j > i + 2) {
          flushPlain(parts, s, plain, i);
          parts.push('<strong>');
          inlineInto(parts, s, i + 2, j, env);
          parts.push('</strong>');
          plain = j + 2;
          SPECIAL.lastIndex = plain;
        } else SPECIAL.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, to);
      if (j > i + 1) {
        flushPlain(parts, s, plain, i);
        parts.push('<em>');
        inlineInto(parts, s, i + 1, j, env);
        parts.push('</em>');
        plain = j + 1;
        SPECIAL.lastIndex = plain;
      }
      continue;
    }
    const k = findUnescapedByte(s, 93, i + 1, to);
    if (k !== -1 && k + 1 < to && s.charCodeAt(k + 1) === 40) {
      const paren = s.indexOf(')', k + 2);
      if (paren !== -1 && paren < to && paren > k + 2 && !hasWsRange(s, k + 2, paren)) {
        flushPlain(parts, s, plain, i);
        parts.push('<a href="');
        const href = env.link(s.slice(k + 2, paren));
        pushEscaped(parts, href, 0, href.length);
        parts.push('">');
        inlineInto(parts, s, i + 1, k, env);
        parts.push('</a>');
        plain = paren + 1;
        SPECIAL.lastIndex = plain;
      }
    }
  }
}

const scratch = [];
function inlineString(s, env) {
  scratch.length = 0;
  inlineInto(scratch, s, 0, s.length, env);
  if (scratch.length === 0) return '';
  if (scratch.length === 1) return scratch[0];
  return scratch.join('');
}

function renderMarkdown(src, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const tokens = lex(src);
  for (let t = 0; t < tokens.length; ) {
    const kind = tokens[t++];
    if (kind === 2) {
      const depth = tokens[t++];
      const text = tokens[t++];
      const id = uniqueSlug(slugify(text), ids);
      const html = inlineString(text, env);
      out.push('<h', depth, ' id="', id, '">', html, '</h', depth, '>\n');
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
    } else if (kind === 1) {
      const lang = tokens[t++];
      const lines = tokens[t++];
      if (lang === '') out.push('<pre><code>');
      else {
        out.push('<pre><code class="language-');
        pushEscaped(out, lang, 0, lang.length);
        out.push('">');
      }
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        pushEscaped(out, line, 0, line.length);
        out.push('\n');
      }
      out.push('</code></pre>\n');
    } else if (kind === 3) {
      out.push('<hr>\n');
    } else if (kind === 4) {
      const body = tokens[t++];
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        const joined = body.join('\n');
        inlineInto(out, joined, 0, joined.length, env);
        out.push('</p>\n</blockquote>\n');
      }
    } else if (kind === 5) {
      const ordered = tokens[t++];
      const start = tokens[t++];
      const items = tokens[t++];
      const tag = ordered ? 'ol' : 'ul';
      if (ordered && start !== 1) out.push('<ol start="', start, '">\n');
      else out.push('<', tag, '>\n');
      for (let li = 0; li < items.length; li++) {
        out.push('<li>');
        const item = items[li];
        inlineInto(out, item, 0, item.length, env);
        out.push('</li>\n');
      }
      out.push('</', tag, '>\n');
    } else {
      const text = tokens[t++];
      if (excerpt === null) {
        const html = inlineString(text, env);
        excerpt = html;
        out.push('<p>', html, '</p>\n');
      } else {
        out.push('<p>');
        inlineInto(out, text, 0, text.length, env);
        out.push('</p>\n');
      }
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const tokens = tokenize(name, src);
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

function lookup(scope, path) {
  const p0 = path[0];
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, p0)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[p0];
  const n = path.length;
  for (let k = 1; k < n; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function collectFree(nodes, bound, out, templates, stack) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const k = n.kind;
    if (k === 'var' || k === 'raw') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    } else if (k === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      collectFree(n.then, bound, out, templates, stack);
      if (n.else !== null) collectFree(n.else, bound, out, templates, stack);
    } else if (k === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const child = new Set(bound);
      child.add(n.name);
      child.add('loop');
      collectFree(n.body, child, out, templates, stack);
    } else if (k === 'include') {
      if (stack.has(n.name)) continue;
      const t = templates.get(n.name);
      if (t === undefined) continue;
      stack.add(n.name);
      collectFree(t, bound, out, templates, stack);
      stack.delete(n.name);
    }
  }
}

function maxRelCaller(nodes, templates, stack) {
  let m = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'for') {
      const c = maxRelCaller(n.body, templates, stack);
      if (c > m) m = c;
    } else if (n.kind === 'if') {
      const a = maxRelCaller(n.then, templates, stack);
      if (a > m) m = a;
      if (n.else !== null) {
        const b = maxRelCaller(n.else, templates, stack);
        if (b > m) m = b;
      }
    } else if (n.kind === 'include') {
      if (m < 0) m = 0;
      if (stack.has(n.name)) {
        m = 99;
        continue;
      }
      const t = templates.get(n.name);
      if (t === undefined) continue;
      stack.add(n.name);
      const cm = maxRelCaller(t, templates, stack);
      stack.delete(n.name);
      if (cm >= 0 && cm + 1 > m) m = cm + 1;
    }
  }
  return m;
}

function shadowed(scope, set) {
  let s = scope;
  while (s.parent !== null) {
    const vars = s.vars;
    for (const name of set) if (Object.hasOwn(vars, name)) return true;
    s = s.parent;
  }
  return false;
}

function includeRender(name, scope, parts, depth, ctx) {
  const fn = ctx.fns.get(name);
  if (fn === undefined || depth >= 8) return;
  const meta = ctx.meta.get(name);
  if (meta !== undefined && meta.cacheable && (meta.rel < 0 || depth + 1 + meta.rel < 8) && !shadowed(scope, meta.free)) {
    let cached = ctx.cache.get(name);
    if (cached === undefined) {
      const sub = [];
      fn(sub, scope, depth + 1, ctx);
      cached = sub.length === 1 ? sub[0] : sub.join('');
      ctx.cache.set(name, cached);
    }
    if (cached !== '') parts.push(cached);
  } else fn(parts, scope, depth + 1, ctx);
}

function compileTemplate(nodes) {
  const paths = [];
  const pathIds = new Map();
  const pid = (path) => {
    const key = path.join('\0');
    let id = pathIds.get(key);
    if (id === undefined) {
      id = paths.length;
      paths.push(path);
      pathIds.set(key, id);
    }
    return id;
  };
  const lines = ['var s=scope;'];
  let seq = 0;
  const emit = (list) => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.kind === 'text') lines.push(`p.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') lines.push(`p.push(H(T(L(s,P[${pid(n.path)}]))));`);
      else if (n.kind === 'raw') lines.push(`p.push(T(L(s,P[${pid(n.path)}])));`);
      else if (n.kind === 'if') {
        lines.push(`if(Q(L(s,P[${pid(n.path)}]))!==${n.not}){`);
        emit(n.then);
        if (n.else !== null) {
          lines.push('}else{');
          emit(n.else);
        }
        lines.push('}');
      } else if (n.kind === 'for') {
        const k = seq++;
        lines.push(`var xs${k}=L(s,P[${pid(n.path)}]);if(Array.isArray(xs${k})){for(var i${k}=0,n${k}=xs${k}.length;i${k}<n${k};i${k}++){var ps${k}=s,v${k}={};v${k}[${JSON.stringify(n.name)}]=xs${k}[i${k}];v${k}.loop={index:i${k}+1,first:i${k}===0,last:i${k}===n${k}-1,length:n${k}};s={vars:v${k},parent:ps${k}};`);
        emit(n.body);
        lines.push(`s=ps${k};}}`);
      } else if (n.kind === 'include') lines.push(`I(${JSON.stringify(n.name)},s,p,depth,ctx);`);
    }
  };
  emit(nodes);
  const factory = new Function('P', 'L', 'T', 'H', 'Q', 'I', `return function(p,scope,depth,ctx){${lines.join('')}};`);
  return factory(paths, lookup, textOf, escapeHtml, truthy, includeRender);
}

// ---------------------------------------------------------------- build

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function hasScheme(target) {
  const n = target.length;
  if (n < 2) return false;
  let c = target.charCodeAt(0);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  for (let i = 1; i < n; i++) {
    c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

function resolvePath(dir, rel) {
  const parts = [];
  if (dir !== '') {
    let s = 0;
    for (let i = 0; i <= dir.length; i++) {
      if (i === dir.length || dir.charCodeAt(i) === 47) {
        parts.push(dir.slice(s, i));
        s = i + 1;
      }
    }
  }
  let s = 0;
  const n = rel.length;
  for (let i = 0; i <= n; i++) {
    if (i === n || rel.charCodeAt(i) === 47) {
      const segLen = i - s;
      if (segLen === 0 || (segLen === 1 && rel.charCodeAt(s) === 46)) {
        s = i + 1;
        continue;
      }
      if (segLen === 2 && rel.charCodeAt(s) === 46 && rel.charCodeAt(s + 1) === 46) {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(rel.slice(s, i));
      s = i + 1;
    }
  }
  return parts.join('/');
}

function normalizeNewlines(s) {
  if (s.indexOf('\r') === -1) return s;
  return s.replace(/\r\n?/g, '\n');
}

function linkOf(s) {
  if (s === null) return null;
  const date = s.data.date;
  return {
    title: s.data.title,
    url: s.url,
    date: date === undefined ? '' : date,
    date_long: date === undefined ? '' : longDate(date),
  };
}

function cardOf(s) {
  const date = s.data.date;
  const tags = s.tagRefs;
  const tagCards = new Array(tags.length);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    tagCards[i] = { name: t.name, slug: t.slug, url: t.url };
  }
  return {
    title: s.data.title,
    url: s.url,
    date: date === undefined ? '' : date,
    date_long: date === undefined ? '' : longDate(date),
    summary: s.data.summary === undefined ? '' : s.data.summary,
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordCount(s.body) / 200)),
    tags: tagCards,
  };
}

function pageOf(s, card) {
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer === undefined ? null : s.newer),
    older: linkOf(s.older === undefined ? null : s.older),
    is_post: s.post,
  };
}

function ownTags(list) {
  if (list === undefined) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    const slug = slugify(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(name);
  }
  return out;
}

export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates);
  names.sort(cmp);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const meta = new Map();
  for (const [name, nodes] of templates) {
    const free = new Set();
    collectFree(nodes, new Set(), free, templates, new Set([name]));
    let cacheable = true;
    for (const v of free) {
      if (!CONST_VARS.has(v)) {
        cacheable = false;
        break;
      }
    }
    const rel = maxRelCaller(nodes, templates, new Set([name]));
    meta.set(name, { free, cacheable, rel });
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = input.files.slice();
  files.sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: normalizeNewlines(f.content) });
    else statics.push(f);
  }

  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout === undefined ? (s.post ? 'post' : 'page') : s.data.layout;
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : undefined);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug === undefined ? slugify(s.data.title) : s.data.slug, set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      link(target) {
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35 || hasScheme(target)) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const src = bySource.get(path);
          if (src !== undefined) return src.url + frag;
          if (staticPaths.has(path)) return base + '/' + path + frag;
        }
        broken.add('broken-link ' + s.path + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const names = ownTags(p.data.tags);
    const refs = new Array(names.length);
    for (let t = 0; t < names.length; t++) {
      const name = names[t];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      refs[t] = tag;
    }
    p.tagRefs = refs;
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTags(s.data.tags);
    const refs = new Array(names.length);
    for (let t = 0; t < names.length; t++) {
      const name = names[t];
      const slug = slugify(name);
      const tag = bySlug.get(slug);
      refs[t] = tag === undefined ? { name, slug, url: '', posts: [] } : tag;
    }
    s.tagRefs = refs;
  }
  const tags = [];
  for (const tag of bySlug.values()) tags.push(tag);
  tags.sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));

  const site = { title: input.site.title, base_url: base };
  const allTags = new Array(tags.length);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    allTags[i] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  const recentN = input.site.recent;
  const recent = [];
  for (let i = 0; i < posts.length && i < recentN; i++) recent.push(cards.get(posts[i]));

  const fns = new Map();
  for (const [name, nodes] of templates) fns.set(name, compileTemplate(nodes));
  const ctx = { meta, cache: new Map(), fns };
  const render = (name, vars) => {
    const fn = fns.get(name);
    if (fn === undefined) return null;
    const parts = [];
    fn(parts, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, ctx);
    return parts.join('');
  };

  const output = {};
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const card = s.post ? cards.get(s) : cardOf(s);
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s, card) });
  }

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const slice = [];
    const a = (k - 1) * per;
    const b = k * per;
    for (let i = a; i < b && i < posts.length; i++) slice.push(cards.get(posts[i]));
    const html = render('index', {
      posts: slice,
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }

  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const postCards = new Array(t.posts.length);
    for (let p = 0; p < t.posts.length; p++) postCards[p] = cards.get(t.posts[p]);
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: postCards } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  const lines = report.concat([...broken]);
  lines.sort(cmp);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output[REPORT_FILE] = lines.join('\n') + '\n';
  slugCache = null;
  return output;
}
