// makefun-site 1.0.0 drop-in replacement — V7 (flat-string output, zero-deopt loops, fused Step 1+2, dead reading_minutes elimination, fast paragraph \n\n skip)

const RESERVED_ROOT = ['posts', 'tags', 'page'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MAX_SLUG_LEN = 64;
const MAX_INCLUDE_DEPTH = 8;

const VALID_FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const TPL_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF_RE = /^if (not )?(\S+)$/;
const TPL_INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const BLANK_LINE_RE = /^[ \t]*$/;

const ESCAPABLE_TABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE_TABLE[ch.charCodeAt(0)] = 1;
}

const SPACE_256 = new Uint8Array(256);
SPACE_256[9] = 1;
SPACE_256[10] = 1;
SPACE_256[11] = 1;
SPACE_256[12] = 1;
SPACE_256[13] = 1;
SPACE_256[32] = 1;
SPACE_256[160] = 1;

const HTML_256 = new Uint8Array(256);
HTML_256[34] = 1; // "
HTML_256[38] = 1; // &
HTML_256[39] = 1; // '
HTML_256[60] = 1; // <
HTML_256[62] = 1; // >

const HTML_ENT = new Array(64);
HTML_ENT[34] = '&quot;';
HTML_ENT[38] = '&amp;';
HTML_ENT[39] = '&#39;';
HTML_ENT[60] = '&lt;';
HTML_ENT[62] = '&gt;';

// 1 = HTML entity (& < > " '), 2 = \, 3 = `, 4 = *, 5 = [
const INLINE_256 = new Uint8Array(256);
INLINE_256[34] = 1;
INLINE_256[38] = 1;
INLINE_256[39] = 1;
INLINE_256[60] = 1;
INLINE_256[62] = 1;
INLINE_256[92] = 2;
INLINE_256[96] = 3;
INLINE_256[42] = 4;
INLINE_256[91] = 5;

function isHighUnicodeSpace(c) {
  return (
    c === 0xfeff ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

function hasNoLineSep(s, start, end) {
  for (let i = start; i < end; i++) {
    if ((s.charCodeAt(i) | 1) === 0x2029) return false;
  }
  return true;
}

function cmpCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeHtmlRange(str, start, end) {
  const tbl = HTML_256;
  const ent = HTML_ENT;
  let i = start;
  let last = start;
  let out = '';
  while (true) {
    while (i < end) {
      const c = str.charCodeAt(i);
      if (c < 256 && tbl[c] !== 0) break;
      i++;
    }
    if (i >= end) break;
    if (i > last) out += str.slice(last, i);
    out += ent[str.charCodeAt(i)];
    i++;
    last = i;
  }
  if (last === start) return start === 0 && end === str.length ? str : str.slice(start, end);
  if (last < end) out += str.slice(last, end);
  return out;
}

function normalizeNonAscii(text, start, end) {
  return (start === 0 && end === text.length ? text : text.slice(start, end))
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

function slugifyRange(text, start, end) {
  let src = text;
  let s = start;
  let e = end;
  for (let i = start; i < end; i++) {
    if (text.charCodeAt(i) >= 128) {
      src = normalizeNonAscii(text, start, end);
      s = 0;
      e = src.length;
      break;
    }
  }
  let out = '';
  let needDash = false;
  let outLen = 0;
  for (let i = s; i < e; i++) {
    const code = src.charCodeAt(i);
    let ch = 0;
    if (code >= 97 && code <= 122) ch = code;
    else if (code >= 65 && code <= 90) ch = code + 32;
    else if (code >= 48 && code <= 57) ch = code;
    if (ch === 0) {
      if (outLen > 0) needDash = true;
    } else {
      if (needDash) {
        if (outLen === MAX_SLUG_LEN) break;
        out += '-';
        outLen++;
        needDash = false;
        if (outLen === MAX_SLUG_LEN) break;
      }
      out += String.fromCharCode(ch);
      outLen++;
      if (outLen === MAX_SLUG_LEN) break;
    }
  }
  if (outLen === 0) return 'untitled';
  if (out.charCodeAt(outLen - 1) === 45) return out.slice(0, outLen - 1);
  return out;
}

function slugify(text) {
  return slugifyRange(text, 0, text.length);
}

function allocateSlug(base, used) {
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

function formatLongDate(dateStr) {
  const m = (dateStr.charCodeAt(5) - 48) * 10 + (dateStr.charCodeAt(6) - 48);
  const d = (dateStr.charCodeAt(8) - 48) * 10 + (dateStr.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${dateStr.slice(0, 4)}`;
}

function countWords(text) {
  const tbl = SPACE_256;
  const len = text.length;
  let count = 0;
  let prevSp = 1;
  let i = 0;
  const lim = len - 3;
  while (i < lim) {
    const c0 = text.charCodeAt(i);
    const c1 = text.charCodeAt(i + 1);
    const c2 = text.charCodeAt(i + 2);
    const c3 = text.charCodeAt(i + 3);
    if ((c0 | c1 | c2 | c3) < 256) {
      const s0 = tbl[c0];
      const s1 = tbl[c1];
      const s2 = tbl[c2];
      const s3 = tbl[c3];
      count += (prevSp & (s0 ^ 1)) + (s0 & (s1 ^ 1)) + (s1 & (s2 ^ 1)) + (s2 & (s3 ^ 1));
      prevSp = s3;
      i += 4;
    } else {
      const sp = c0 < 256 ? tbl[c0] : (c0 >= 0x1680 && isHighUnicodeSpace(c0) ? 1 : 0);
      count += prevSp & (sp ^ 1);
      prevSp = sp;
      i++;
    }
  }
  for (; i < len; i++) {
    const c = text.charCodeAt(i);
    const sp = c < 256 ? tbl[c] : (c >= 0x1680 && isHighUnicodeSpace(c) ? 1 : 0);
    count += prevSp & (sp ^ 1);
    prevSp = sp;
  }
  return count;
}

function parentDir(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function hasScheme(target) {
  const len = target.length;
  if (len < 2) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < len; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      (c >= 97 && c <= 122) ||
      (c >= 65 && c <= 90) ||
      (c >= 48 && c <= 57) ||
      c === 43 ||
      c === 45 ||
      c === 46
    ) {
      continue;
    }
    return false;
  }
  return false;
}

function resolveRelPathFromParts(dirParts, rel) {
  const stack = dirParts.length === 0 ? [] : dirParts.slice();
  const len = rel.length;
  let pos = 0;
  while (pos < len) {
    let slash = rel.indexOf('/', pos);
    if (slash === -1) slash = len;
    const segLen = slash - pos;
    if (segLen === 0 || (segLen === 1 && rel.charCodeAt(pos) === 46)) {
      // '' or '.'
    } else if (segLen === 2 && rel.charCodeAt(pos) === 46 && rel.charCodeAt(pos + 1) === 46) {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(rel.slice(pos, slash));
    }
    pos = slash + 1;
  }
  return stack.join('/');
}

// ---------------- Front matter ----------------

function daysInMonth(year, month) {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function parseFmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    const last = raw.length - 1;
    for (let i = 1; i < last; i++) {
      const ch = raw[i];
      if (ch === '\\') {
        const next = raw[i + 1];
        if ((next !== '"' && next !== '\\') || i + 1 === last) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += next;
        i++;
      } else if (ch === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += ch;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) {
    return { error: 'a bare string opens on [' };
  }
  return { value: raw };
}

function isValidLayout(raw) {
  const len = raw.length;
  if (len === 0) return false;
  for (let i = 0; i < len; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isValidSlug(raw) {
  const len = raw.length;
  if (len === 0 || len > 64) return false;
  let prevDash = true;
  for (let i = 0; i < len; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
    } else if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else {
      return false;
    }
  }
  return !prevDash;
}

function isValidTagText(item) {
  const len = item.length;
  if (len === 0) return false;
  for (let i = 0; i < len; i++) {
    const c = item.charCodeAt(i);
    if (c === 34 || c === 91 || c === 93) return false;
  }
  return true;
}

function parseFmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const res = parseFmString(raw);
    return res.error !== undefined ? { error: `key "${key}": ${res.error}` } : res;
  }
  if (key === 'date') {
    if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    const d0 = raw.charCodeAt(0) - 48;
    const d1 = raw.charCodeAt(1) - 48;
    const d2 = raw.charCodeAt(2) - 48;
    const d3 = raw.charCodeAt(3) - 48;
    const m0 = raw.charCodeAt(5) - 48;
    const m1 = raw.charCodeAt(6) - 48;
    const day0 = raw.charCodeAt(8) - 48;
    const day1 = raw.charCodeAt(9) - 48;
    if (
      (d0 | d1 | d2 | d3 | m0 | m1 | day0 | day1) < 0 ||
      d0 > 9 || d1 > 9 || d2 > 9 || d3 > 9 || m0 > 9 || m1 > 9 || day0 > 9 || day1 > 9
    ) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    const y = d0 * 1000 + d1 * 100 + d2 * 10 + d3;
    const mo = m0 * 10 + m1;
    const d = day0 * 10 + day1;
    if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const parts = inner.split(',');
    const tags = new Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i].trim();
      if (!isValidTagText(item)) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags[i] = item;
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return isValidLayout(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    return isValidSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

function parseFrontMatter(text) {
  const len = text.length;
  const nl0 = text.indexOf('\n');
  const line0End = nl0 === -1 ? len : nl0;
  if (
    line0End !== 3 ||
    text.charCodeAt(0) !== 45 ||
    text.charCodeAt(1) !== 45 ||
    text.charCodeAt(2) !== 45
  ) {
    return { error: 'no front matter' };
  }
  if (nl0 === -1) return { error: 'the front matter is not closed' };

  let closePos = -1;
  let searchFrom = nl0;
  while (true) {
    const idx = text.indexOf('\n---', searchFrom);
    if (idx === -1) return { error: 'the front matter is not closed' };
    const after = idx + 4;
    if (after === len || text.charCodeAt(after) === 10) {
      closePos = idx + 1;
      break;
    }
    searchFrom = idx + 1;
  }

  const data = {};
  let pos = nl0 + 1;
  let lineNum = 2;
  while (pos < closePos) {
    const nl = text.indexOf('\n', pos);
    const le = nl === -1 || nl > closePos ? closePos : nl;

    if (pos < le && text.charCodeAt(pos) === 35) {
      pos = le + 1;
      lineNum++;
      continue;
    }
    let p = pos;
    while (p < le) {
      const c = text.charCodeAt(p);
      if (c !== 32 && c !== 9) break;
      p++;
    }
    if (p === le) {
      pos = le + 1;
      lineNum++;
      continue;
    }

    let kp = pos;
    while (kp < le) {
      const c = text.charCodeAt(kp);
      if ((c >= 97 && c <= 122) || c === 95) kp++;
      else break;
    }
    if (kp === pos || kp >= le || text.charCodeAt(kp) !== 58) {
      return { error: `line ${lineNum} is not "key: value"` };
    }
    let valStart = kp + 1;
    if (valStart < le) {
      if (text.charCodeAt(valStart) !== 32) {
        return { error: `line ${lineNum} is not "key: value"` };
      }
      valStart++;
      if (!hasNoLineSep(text, valStart, le)) {
        return { error: `line ${lineNum} is not "key: value"` };
      }
    }
    const key = text.slice(pos, kp);
    if (!VALID_FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };

    let valEnd = le;
    while (valEnd > valStart) {
      const c = text.charCodeAt(valEnd - 1);
      if (c === 32 || c === 9) valEnd--;
      else break;
    }
    if (valStart >= valEnd) return { error: `key "${key}" has no value` };
    const parsed = parseFmValue(key, text.slice(valStart, valEnd));
    if (parsed.error !== undefined) return parsed;
    data[key] = parsed.value;

    pos = le + 1;
    lineNum++;
  }

  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const closeEnd = closePos + 3;
  return { data, body: closeEnd < len ? text.slice(closeEnd + 1) : '' };
}

// ---------------- Templates ----------------

class TplParseError extends Error {}

function parsePath(tplName, raw) {
  if (!TPL_PATH_RE.test(raw)) {
    throw new TplParseError(`template "${tplName}": ${JSON.stringify(raw)} is not a path`);
  }
  return raw.split('.');
}

function lexTemplate(tplName, src) {
  const tokens = [];
  let buf = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      buf += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      buf += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    buf += src.slice(i, open);
    if (next === 123) {
      const isRaw = src.charCodeAt(open + 2) === 123;
      const delimLen = isRaw ? 3 : 2;
      const close = src.indexOf(isRaw ? '}}}' : '}}', open + delimLen);
      if (close === -1) {
        throw new TplParseError(`template "${tplName}": a ${isRaw ? '{{{' : '{{'} is not closed`);
      }
      if (buf !== '') {
        tokens.push({ kind: 'text', text: buf });
        buf = '';
      }
      tokens.push({ kind: isRaw ? 'raw' : 'var', path: parsePath(tplName, src.slice(open + delimLen, close).trim()) });
      i = close + delimLen;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) {
      throw new TplParseError(`template "${tplName}": a {% is not closed`);
    }
    const end = close + 2;
    const lineStart = open === 0 ? 0 : src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone =
      BLANK_LINE_RE.test(src.slice(lineStart, open)) &&
      BLANK_LINE_RE.test(src.slice(end, lineEnd));
    if (standalone) {
      buf = buf.slice(0, buf.length - (open - lineStart));
    }
    if (buf !== '') {
      tokens.push({ kind: 'text', text: buf });
      buf = '';
    }
    tokens.push({ kind: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (buf !== '') tokens.push({ kind: 'text', text: buf });
  return tokens;
}

function compileTemplate(tplName, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let cur = root.body;
  const tokens = lexTemplate(tplName, src);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind !== 'tag') {
      cur.push(tok);
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = TPL_FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: parsePath(tplName, m[2]), body: [] };
      cur.push(node);
      stack.push(node);
      cur = node.body;
    } else if ((m = TPL_IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', negate: m[1] !== undefined, path: parsePath(tplName, m[2]), thenBody: [], elseBody: null };
      cur.push(node);
      stack.push(node);
      cur = node.thenBody;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.elseBody !== null) {
        throw new TplParseError(`template "${tplName}": an else outside an if`);
      }
      top.elseBody = [];
      cur = top.elseBody;
    } else if (tag === 'endfor' || tag === 'endif') {
      const expected = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== expected) {
        throw new TplParseError(`template "${tplName}": an ${tag} with no open ${expected}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      cur = parent.kind === 'if' ? (parent.elseBody ?? parent.thenBody) : parent.body;
    } else if ((m = TPL_INCLUDE_RE.exec(tag)) !== null) {
      cur.push({ kind: 'include', name: m[1] });
    } else {
      throw new TplParseError(`template "${tplName}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TplParseError(`template "${tplName}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

function resolvePropChain(val, path, startIdx) {
  for (let i = startIdx; i < path.length; i++) {
    if (val === null || typeof val !== 'object' || !Object.hasOwn(val, path[i])) return undefined;
    val = val[path[i]];
  }
  return val;
}

function valueToText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = valueToText(v[i]);
    return out.join(', ');
  }
  return '';
}

function valueToEscapedText(v) {
  if (typeof v === 'string') return escapeHtmlRange(v, 0, v.length);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = valueToText(v[i]);
    const joined = out.join(', ');
    return escapeHtmlRange(joined, 0, joined.length);
  }
  return '';
}

function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const OP_TEXT = 0;
const OP_VAR = 1;
const OP_RAW = 2;
const OP_IF = 3;
const OP_FOR = 4;
const OP_FOR_CONST = 5;

class Op {
  constructor(op, text, acc, negate, thenOps, elseOps, arr, itemSlot, loopSlot, bodyOps, loopObj, pureCache, pureSlots) {
    this.op = op;
    this.text = text;
    this.acc = acc;
    this.negate = negate;
    this.thenOps = thenOps;
    this.elseOps = elseOps;
    this.arr = arr;
    this.itemSlot = itemSlot;
    this.loopSlot = loopSlot;
    this.bodyOps = bodyOps;
    this.loopObj = loopObj;
    this.pureCache = pureCache;
    this.pureSlots = pureSlots;
  }
}

function pushTextOp(out, text) {
  if (text === '') return;
  const n = out.length;
  if (n > 0 && out[n - 1].op === OP_TEXT) {
    out[n - 1].text += text;
  } else {
    out.push(new Op(OP_TEXT, text, null, false, null, null, null, 0, 0, null, null, null, null));
  }
}

function makeAccessor(slot, path) {
  const propLen = path.length - 1;
  return {
    slot,
    propLen,
    p1: propLen >= 1 ? path[1] : null,
    p2: propLen >= 2 ? path[2] : null,
    rest: propLen >= 3 ? path.slice(1) : null,
  };
}

function checkReadingMinutesPath(path, st) {
  for (let i = 1; i < path.length; i++) {
    if (path[i] === 'reading_minutes') {
      st.usesReadingMinutes = true;
      return;
    }
  }
}

function readAccessor(slots, acc) {
  let v = slots[acc.slot];
  const n = acc.propLen;
  if (n === 0) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, acc.p1)) return undefined;
  v = v[acc.p1];
  if (n === 1) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, acc.p2)) return undefined;
  v = v[acc.p2];
  if (n === 2) return v;
  const rest = acc.rest;
  for (let i = 2; i < rest.length; i++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, rest[i])) return undefined;
    v = v[rest[i]];
  }
  return v;
}

function envLookup(env, name) {
  let cur = env;
  while (cur !== null) {
    if (Object.hasOwn(cur.bindings, name)) return cur.bindings[name];
    cur = cur.parent;
  }
  return { known: true, value: undefined };
}

function accKey(acc) {
  const n = acc.propLen;
  if (n === 0) return `${acc.slot}#0`;
  if (n === 1) return `${acc.slot}#1:${acc.p1}`;
  if (n === 2) return `${acc.slot}#2:${acc.p1}.${acc.p2}`;
  return `${acc.slot}#${n}:${acc.rest.join('.')}`;
}

function opsKey(list) {
  let out = '[';
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (i > 0) out += ',';
    if (o.op === OP_TEXT) {
      out += `0:${JSON.stringify(o.text)}`;
    } else if (o.op === OP_VAR || o.op === OP_RAW) {
      out += `${o.op}:${accKey(o.acc)}`;
    } else if (o.op === OP_IF) {
      out += `3:${accKey(o.acc)}:${o.negate ? 1 : 0}:${opsKey(o.thenOps)};${o.elseOps ? opsKey(o.elseOps) : '!'}`;
    } else if (o.op === OP_FOR) {
      out += `4:${accKey(o.acc)}:${o.pureCache !== null ? 'P' : `D${o.itemSlot}:${o.loopSlot}`}:${opsKey(o.bodyOps)}`;
    }
  }
  return `${out}]`;
}

function rebaseOpsList(list, delta, state) {
  const res = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.op === OP_TEXT) {
      res[i] = new Op(OP_TEXT, o.text, null, false, null, null, null, 0, 0, null, null, null, null);
    } else if (o.op === OP_VAR || o.op === OP_RAW) {
      const s = o.acc.slot - delta;
      if (s + 1 > state.maxS) state.maxS = s + 1;
      res[i] = new Op(o.op, null, { slot: s, propLen: o.acc.propLen, p1: o.acc.p1, p2: o.acc.p2, rest: o.acc.rest }, false, null, null, null, 0, 0, null, null, null, null);
    } else if (o.op === OP_IF) {
      const s = o.acc.slot - delta;
      if (s + 1 > state.maxS) state.maxS = s + 1;
      res[i] = new Op(
        OP_IF, null, { slot: s, propLen: o.acc.propLen, p1: o.acc.p1, p2: o.acc.p2, rest: o.acc.rest },
        o.negate, rebaseOpsList(o.thenOps, delta, state), o.elseOps === null ? null : rebaseOpsList(o.elseOps, delta, state),
        null, 0, 0, null, null, null, null
      );
    } else if (o.op === OP_FOR) {
      const s = o.acc.slot - delta;
      if (s + 1 > state.maxS) state.maxS = s + 1;
      const newAcc = { slot: s, propLen: o.acc.propLen, p1: o.acc.p1, p2: o.acc.p2, rest: o.acc.rest };
      if (o.pureCache !== null) {
        res[i] = new Op(OP_FOR, null, newAcc, false, null, null, null, o.itemSlot, o.loopSlot, o.bodyOps, o.loopObj, o.pureCache, o.pureSlots);
      } else {
        const is = o.itemSlot - delta;
        const ls = o.loopSlot - delta;
        if (is + 1 > state.maxS) state.maxS = is + 1;
        if (ls + 1 > state.maxS) state.maxS = ls + 1;
        res[i] = new Op(OP_FOR, null, newAcc, false, null, null, null, is, ls, rebaseOpsList(o.bodyOps, delta, state), { index: 0, first: false, last: false, length: 0 }, null, null);
      }
    } else {
      state.hasConstArr = true;
      res[i] = o;
    }
  }
  return res;
}

function specForNode(n, env, depth, out, minUsedSlotBox, nextSlot, st) {
  const b = envLookup(env, n.path[0]);
  if (b.known) {
    const arr = resolvePropChain(b.value, n.path, 1);
    if (!Array.isArray(arr) || arr.length === 0) return;
    const savedLen = out.length;
    const savedLastText = savedLen > 0 && out[savedLen - 1].op === OP_TEXT ? out[savedLen - 1].text : null;
    const savedMin = minUsedSlotBox.min;
    let aborted = false;
    const arrLen = arr.length;
    for (let k = 0; k < arrLen; k++) {
      const bindings = Object.create(null);
      bindings[n.name] = { known: true, value: arr[k] };
      bindings.loop = {
        known: true,
        value: { index: k + 1, first: k === 0, last: k === arrLen - 1, length: arrLen },
      };
      specNodes(n.body, { bindings, parent: env }, depth, out, minUsedSlotBox, nextSlot, st);
      if (out.length - savedLen > 128) {
        aborted = true;
        break;
      }
    }
    if (!aborted) return;
    out.length = savedLen;
    if (savedLastText !== null) out[savedLen - 1].text = savedLastText;
    minUsedSlotBox.min = savedMin;
    const lSlot = nextSlot;
    const iSlot = nextSlot + 1;
    if (iSlot + 1 > st.maxSlots) st.maxSlots = iSlot + 1;
    const bindings = Object.create(null);
    bindings[n.name] = { known: false, slot: iSlot };
    bindings.loop = { known: false, slot: lSlot };
    const bodyOps = [];
    specNodes(n.body, { bindings, parent: env }, depth, bodyOps, minUsedSlotBox, nextSlot + 2, st);
    if (bodyOps.length > 0) {
      out.push(new Op(OP_FOR_CONST, null, null, false, null, null, arr, iSlot, lSlot, bodyOps, { index: 0, first: false, last: false, length: 0 }, null, null));
    }
    return;
  }

  checkReadingMinutesPath(n.path, st);
  if (b.slot < minUsedSlotBox.min) minUsedSlotBox.min = b.slot;
  const lSlot = nextSlot;
  const iSlot = nextSlot + 1;
  if (iSlot + 1 > st.maxSlots) st.maxSlots = iSlot + 1;
  const bindings = Object.create(null);
  bindings[n.name] = { known: false, slot: iSlot };
  bindings.loop = { known: false, slot: lSlot };

  const innerBox = { min: 1e9 };
  const bodyOps = [];
  specNodes(n.body, { bindings, parent: env }, depth, bodyOps, innerBox, nextSlot + 2, st);
  if (innerBox.min < minUsedSlotBox.min) minUsedSlotBox.min = innerBox.min;
  if (bodyOps.length === 0) return;

  let pureCache = null;
  let pureOps = null;
  let pureSlots = null;
  if (n.name !== 'loop' && innerBox.min >= iSlot) {
    const rState = { maxS: 1, hasConstArr: false };
    const rebasedOps = rebaseOpsList(bodyOps, iSlot, rState);
    if (!rState.hasConstArr) {
      const cacheKey = opsKey(rebasedOps);
      pureCache = st.sharedItemCaches.get(cacheKey);
      if (pureCache === undefined) {
        pureCache = new Map();
        st.sharedItemCaches.set(cacheKey, pureCache);
      }
      pureOps = rebasedOps;
      pureSlots = new Array(rState.maxS);
    }
  }

  out.push(new Op(
    OP_FOR, null, makeAccessor(b.slot, n.path), false, null, null, null,
    iSlot, lSlot, pureOps ?? bodyOps, { index: 0, first: false, last: false, length: 0 }, pureCache, pureSlots
  ));
}

function specNodes(nodes, env, depth, out, minUsedSlotBox, nextSlot, st) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const kind = n.kind;
    if (kind === 'text') {
      pushTextOp(out, n.text);
    } else if (kind === 'include') {
      if (depth < MAX_INCLUDE_DEPTH) {
        const sub = st.templates.get(n.name);
        if (sub !== undefined) specNodes(sub, env, depth + 1, out, minUsedSlotBox, nextSlot, st);
      }
    } else if (kind === 'var' || kind === 'raw') {
      const b = envLookup(env, n.path[0]);
      if (b.known) {
        const val = resolvePropChain(b.value, n.path, 1);
        pushTextOp(out, kind === 'var' ? valueToEscapedText(val) : valueToText(val));
      } else {
        checkReadingMinutesPath(n.path, st);
        if (b.slot < minUsedSlotBox.min) minUsedSlotBox.min = b.slot;
        out.push(new Op(kind === 'var' ? OP_VAR : OP_RAW, null, makeAccessor(b.slot, n.path), false, null, null, null, 0, 0, null, null, null, null));
      }
    } else if (kind === 'if') {
      const b = envLookup(env, n.path[0]);
      if (b.known) {
        const branch = (isTruthy(resolvePropChain(b.value, n.path, 1)) !== n.negate) ? n.thenBody : n.elseBody;
        if (branch !== null) specNodes(branch, env, depth, out, minUsedSlotBox, nextSlot, st);
      } else if (b.truthyObj && n.path.length === 1) {
        const branch = !n.negate ? n.thenBody : n.elseBody;
        if (branch !== null) specNodes(branch, env, depth, out, minUsedSlotBox, nextSlot, st);
      } else {
        checkReadingMinutesPath(n.path, st);
        if (b.slot < minUsedSlotBox.min) minUsedSlotBox.min = b.slot;
        const thenOps = [];
        specNodes(n.thenBody, env, depth, thenOps, minUsedSlotBox, nextSlot, st);
        let elseOps = null;
        if (n.elseBody !== null) {
          elseOps = [];
          specNodes(n.elseBody, env, depth, elseOps, minUsedSlotBox, nextSlot, st);
          if (elseOps.length === 0) elseOps = null;
        }
        if (thenOps.length === 0 && elseOps === null) continue;
        out.push(new Op(OP_IF, null, makeAccessor(b.slot, n.path), n.negate, thenOps, elseOps, null, 0, 0, null, null, null, null));
      }
    } else if (kind === 'for') {
      specForNode(n, env, depth, out, minUsedSlotBox, nextSlot, st);
    }
  }
}

function specializeTemplate(rootNodes, templates, rootBindings, sharedItemCaches) {
  let maxSlots = 0;
  for (const k in rootBindings) {
    const b = rootBindings[k];
    if (!b.known && b.slot >= maxSlots) maxSlots = b.slot + 1;
  }
  const st = { templates, sharedItemCaches, maxSlots, usesReadingMinutes: false };
  const ops = [];
  specNodes(rootNodes, { bindings: rootBindings, parent: null }, 0, ops, { min: 1e9 }, maxSlots, st);
  return { ops, slots: new Array(st.maxSlots), usesReadingMinutes: st.usesReadingMinutes };
}

function runOpsInto(ops, slots, out) {
  const len = ops.length;
  for (let i = 0; i < len; i++) {
    const o = ops[i];
    const op = o.op;
    if (op === OP_TEXT) {
      out.push(o.text);
    } else if (op === OP_VAR) {
      const s = valueToEscapedText(readAccessor(slots, o.acc));
      if (s !== '') out.push(s);
    } else if (op === OP_RAW) {
      const s = valueToText(readAccessor(slots, o.acc));
      if (s !== '') out.push(s);
    } else if (op === OP_IF) {
      const branch = (isTruthy(readAccessor(slots, o.acc)) !== o.negate) ? o.thenOps : o.elseOps;
      if (branch !== null && branch.length > 0) runOpsInto(branch, slots, out);
    } else {
      const arr = op === OP_FOR ? readAccessor(slots, o.acc) : o.arr;
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const n = arr.length;
      const cache = o.pureCache;
      if (cache !== null) {
        const pSlots = o.pureSlots;
        const body = o.bodyOps;
        for (let k = 0; k < n; k++) {
          const item = arr[k];
          if (item !== null && typeof item === 'object') {
            let cached = cache.get(item);
            if (cached === undefined) {
              pSlots[0] = item;
              const tmp = [];
              runOpsInto(body, pSlots, tmp);
              cached = tmp.join('');
              cache.set(item, cached);
            }
            if (cached !== '') out.push(cached);
          } else {
            pSlots[0] = item;
            runOpsInto(body, pSlots, out);
          }
        }
      } else {
        const iSlot = o.itemSlot;
        const lSlot = o.loopSlot;
        const loopObj = o.loopObj;
        const body = o.bodyOps;
        loopObj.length = n;
        slots[lSlot] = loopObj;
        const lastIdx = n - 1;
        for (let k = 0; k < n; k++) {
          slots[iSlot] = arr[k];
          loopObj.index = k + 1;
          loopObj.first = k === 0;
          loopObj.last = k === lastIdx;
          runOpsInto(body, slots, out);
        }
      }
    }
  }
}

// ---------------- Markdown ----------------

function isBlankRange(src, ls, le) {
  for (let p = ls; p < le; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function matchFenceOpen(src, ls, le) {
  if (le - ls < 3 || src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) {
    return -1;
  }
  let p = ls + 3;
  while (p < le) {
    const c = src.charCodeAt(p);
    if (
      (c >= 97 && c <= 122) ||
      (c >= 65 && c <= 90) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 43 ||
      c === 45
    ) {
      p++;
    } else {
      break;
    }
  }
  const langEnd = p;
  while (p < le) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return -1;
    p++;
  }
  return langEnd;
}

function isFenceClose(src, ls, le) {
  return (
    le - ls >= 3 &&
    src.charCodeAt(ls) === 96 &&
    src.charCodeAt(ls + 1) === 96 &&
    src.charCodeAt(ls + 2) === 96 &&
    isBlankRange(src, ls + 3, le)
  );
}

function matchHeadingRange(src, ls, le) {
  if (ls >= le || src.charCodeAt(ls) !== 35) return 0;
  let p = ls + 1;
  while (p < le && src.charCodeAt(p) === 35) p++;
  const depth = p - ls;
  if (depth > 6 || p >= le) return 0;
  const sp = src.charCodeAt(p);
  if (sp !== 32 && sp !== 9) return 0;
  let hasText = false;
  while (p < le) {
    const c = src.charCodeAt(p);
    if ((c | 1) === 0x2029) return 0;
    if (c !== 32 && c !== 9) hasText = true;
    p++;
  }
  return hasText ? depth : 0;
}

function isHrRange(src, ls, le) {
  if (le - ls < 3) return false;
  const c0 = src.charCodeAt(ls);
  if (c0 !== 45 && c0 !== 42) return false;
  return src.charCodeAt(ls + 1) === c0 && src.charCodeAt(ls + 2) === c0 && isBlankRange(src, ls + 3, le);
}

function isParagraphBreakRange(src, ls, le) {
  if (ls >= le) return true;
  const c0 = src.charCodeAt(ls);
  if (c0 === 32 || c0 === 9) return isBlankRange(src, ls + 1, le);
  if (c0 === 96) return matchFenceOpen(src, ls, le) !== -1;
  if (c0 === 35) return matchHeadingRange(src, ls, le) !== 0;
  if (c0 === 45 || c0 === 42) return isHrRange(src, ls, le);
  return false;
}

function isContinuedRange(src, ls, le) {
  if (le - ls < 3 || src.charCodeAt(ls) !== 32 || src.charCodeAt(ls + 1) !== 32) return false;
  let p = ls + 2;
  while (p < le && src.charCodeAt(p) === 32) p++;
  if (p >= le) return false;
  const c = src.charCodeAt(p);
  return c < 256 ? SPACE_256[c] === 0 : !isHighUnicodeSpace(c);
}

function matchOrderedMarker(src, ls, le) {
  let p = ls;
  const maxD = ls + 9 < le ? ls + 9 : le;
  while (p < maxD) {
    const c = src.charCodeAt(p);
    if (c >= 48 && c <= 57) p++;
    else break;
  }
  if (p === ls || p + 1 >= le) return -1;
  if (src.charCodeAt(p) === 46 && src.charCodeAt(p + 1) === 32 && hasNoLineSep(src, p + 2, le)) return p + 2;
  return -1;
}

function findUnescapedDoubleStarSlow(s, from, end) {
  const tbl = ESCAPABLE_TABLE;
  const limit = end - 1;
  for (let j = from; j < limit; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const c2 = s.charCodeAt(j + 1);
      if (c2 < 128 && tbl[c2] !== 0) {
        j++;
        continue;
      }
    } else if (c === 42 && s.charCodeAt(j + 1) === 42) {
      return j;
    }
  }
  return -1;
}

function findUnescapedDoubleStar(s, from, end) {
  const idx = s.indexOf('**', from);
  if (idx === -1 || idx + 1 >= end) return -1;
  if (idx === from || s.charCodeAt(idx - 1) !== 92) return idx;
  return findUnescapedDoubleStarSlow(s, from, end);
}

function findUnescapedBracketSlow(s, from, end) {
  const tbl = ESCAPABLE_TABLE;
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < end) {
        const c2 = s.charCodeAt(j + 1);
        if (c2 < 128 && tbl[c2] !== 0) {
          j++;
          continue;
        }
      }
    } else if (c === 93) {
      return j;
    }
  }
  return -1;
}

function findUnescapedBracket(s, from, end) {
  const idx = s.indexOf(']', from);
  if (idx === -1 || idx >= end) return -1;
  if (idx === from || s.charCodeAt(idx - 1) !== 92) return idx;
  return findUnescapedBracketSlow(s, from, end);
}

function findClosingSingleStarSlow(s, from, end) {
  const tbl = ESCAPABLE_TABLE;
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < end) {
        const c2 = s.charCodeAt(j + 1);
        if (c2 < 128 && tbl[c2] !== 0) {
          j++;
          continue;
        }
      }
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

function findClosingSingleStar(s, from, end) {
  let pos = from;
  while (pos < end) {
    const idx = s.indexOf('*', pos);
    if (idx === -1 || idx >= end) return -1;
    const next2 = idx + 2;
    if (idx > from && s.charCodeAt(idx - 1) === 92) {
      return findClosingSingleStarSlow(s, from, end);
    }
    if (idx + 1 < end && s.charCodeAt(idx + 1) === 42) {
      pos = next2;
      continue;
    }
    return idx;
  }
  return -1;
}

function hasNoSpace(s, start, end) {
  const tbl = SPACE_256;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c < 256 ? tbl[c] !== 0 : isHighUnicodeSpace(c)) return false;
  }
  return true;
}

function resolveLinkCtx(linkCtx, target) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35 || hasScheme(target)) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const resolved = rel === '' ? null : resolveRelPathFromParts(linkCtx.dirParts, rel);
  if (resolved !== null) {
    const targetSource = linkCtx.bySource.get(resolved);
    if (targetSource !== undefined) return hash === -1 ? targetSource.url : `${targetSource.url}${target.slice(hash)}`;
    if (linkCtx.staticPaths.has(resolved)) {
      return hash === -1 ? `${linkCtx.base}/${resolved}` : `${linkCtx.base}/${resolved}${target.slice(hash)}`;
    }
  }
  linkCtx.broken.add(`broken-link ${linkCtx.sourcePath} -> ${target}`);
  return target;
}

function renderInlineRange(s, start, end, linkCtx) {
  const tbl = INLINE_256;
  const ent = HTML_ENT;
  let i = start;
  let last = start;
  let out = '';
  while (true) {
    while (i < end) {
      const c = s.charCodeAt(i);
      if (c < 256 && tbl[c] !== 0) break;
      i++;
    }
    if (i >= end) break;
    const c = s.charCodeAt(i);
    const kind = tbl[c];
    if (kind === 1) {
      if (i > last) out += s.slice(last, i);
      out += ent[c];
      i++;
      last = i;
    } else if (kind === 4) { // *
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        const j = findUnescapedDoubleStar(s, i + 2, end);
        if (j > i + 2) {
          if (i > last) out += s.slice(last, i);
          out += `<strong>${renderInlineRange(s, i + 2, j, linkCtx)}</strong>`;
          i = j + 2;
          last = i;
        } else {
          i += 2;
        }
      } else {
        const j = findClosingSingleStar(s, i + 1, end);
        if (j > i + 1) {
          if (i > last) out += s.slice(last, i);
          out += `<em>${renderInlineRange(s, i + 1, j, linkCtx)}</em>`;
          i = j + 1;
          last = i;
        } else {
          i++;
        }
      }
    } else if (kind === 5) { // [
      const k = findUnescapedBracket(s, i + 1, end);
      if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
        const m = s.indexOf(')', k + 2);
        if (m > k + 2 && m < end && hasNoSpace(s, k + 2, m)) {
          if (i > last) out += s.slice(last, i);
          const href = resolveLinkCtx(linkCtx, s.slice(k + 2, m));
          out += `<a href="${escapeHtmlRange(href, 0, href.length)}">${renderInlineRange(s, i + 1, k, linkCtx)}</a>`;
          i = m + 1;
          last = i;
        } else {
          i++;
        }
      } else {
        i++;
      }
    } else if (kind === 3) { // `
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < end) {
        if (i > last) out += s.slice(last, i);
        out += `<code>${escapeHtmlRange(s, i + 1, j)}</code>`;
        i = j + 1;
        last = i;
      } else {
        i++;
      }
    } else { // kind === 2 (\)
      if (i + 1 < end) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 < 128 && ESCAPABLE_TABLE[c2] !== 0) {
          if (i > last) out += s.slice(last, i);
          if (c2 === 62) {
            out += '&gt;';
            i += 2;
            last = i;
          } else {
            last = i + 1;
            i += 2;
          }
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
  }
  if (last === start) return start === 0 && end === s.length ? s : s.slice(start, end);
  if (last < end) out += s.slice(last, end);
  return out;
}

function parseFenceBlock(src, len, ls, langEnd, pos, blocks) {
  const bodyStart = pos;
  let hasLines = false;
  let lastLineEnd = bodyStart;
  while (pos <= len) {
    const nl = src.indexOf('\n', pos);
    const le = nl === -1 ? len : nl;
    const nextPos = nl === -1 ? len + 1 : nl + 1;
    if (isFenceClose(src, pos, le)) {
      pos = nextPos;
      break;
    }
    hasLines = true;
    lastLineEnd = le;
    pos = nextPos;
  }
  if (langEnd === ls + 3) {
    blocks.push('<pre><code>');
  } else {
    blocks.push('<pre><code class="language-', escapeHtmlRange(src, ls + 3, langEnd), '">');
  }
  if (hasLines) {
    blocks.push(escapeHtmlRange(src, bodyStart, lastLineEnd), '\n');
  }
  blocks.push('</code></pre>\n');
  return pos;
}

function parseHeadingBlock(src, ls, le, depth, ids, toc, blocks, linkCtx) {
  let ts = ls + depth + 1;
  while (ts < le) {
    const c = src.charCodeAt(ts);
    if (c === 32 || c === 9) ts++;
    else break;
  }
  let te = le;
  while (te > ts) {
    const c = src.charCodeAt(te - 1);
    if (c === 32 || c === 9) te--;
    else break;
  }
  const id = allocateSlug(slugifyRange(src, ts, te), ids);
  const html = renderInlineRange(src, ts, te, linkCtx);
  blocks.push(`<h${depth} id="${id}">`, html, `</h${depth}>\n`);
  if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
}

function parseBulletListBlock(src, len, pos, blocks, linkCtx) {
  blocks.push('<ul>\n');
  let itemSingleStart = -1;
  let itemSingleEnd = -1;
  let itemLines = null;

  while (pos < len) {
    if (src.charCodeAt(pos) === 10) {
      pos++;
      break;
    }
    const nl = src.indexOf('\n', pos);
    const ls = pos;
    const le = nl === -1 ? len : nl;
    const nextPos = nl === -1 ? len + 1 : nl + 1;

    const ch0 = src.charCodeAt(ls);
    if ((ch0 === 45 || ch0 === 42) && ls + 1 < le && src.charCodeAt(ls + 1) === 32 && hasNoLineSep(src, ls + 2, le)) {
      if (itemSingleStart !== -1) {
        blocks.push('<li>', renderInlineRange(src, itemSingleStart, itemSingleEnd, linkCtx), '</li>\n');
        itemSingleStart = -1;
      } else if (itemLines !== null) {
        const joined = itemLines.join('\n');
        blocks.push('<li>', renderInlineRange(joined, 0, joined.length, linkCtx), '</li>\n');
        itemLines = null;
      }
      let ts = ls + 2;
      while (ts < le && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
      let te = le;
      while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
      itemSingleStart = ts;
      itemSingleEnd = te;
      pos = nextPos;
    } else if (isContinuedRange(src, ls, le)) {
      let ts = ls;
      while (ts < le && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
      let te = le;
      while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
      if (itemLines === null) {
        itemLines = [src.slice(itemSingleStart, itemSingleEnd), src.slice(ts, te)];
        itemSingleStart = -1;
      } else {
        itemLines.push(src.slice(ts, te));
      }
      pos = nextPos;
    } else {
      break;
    }
  }
  if (itemSingleStart !== -1) {
    blocks.push('<li>', renderInlineRange(src, itemSingleStart, itemSingleEnd, linkCtx), '</li>\n');
  } else if (itemLines !== null) {
    const joined = itemLines.join('\n');
    blocks.push('<li>', renderInlineRange(joined, 0, joined.length, linkCtx), '</li>\n');
  }
  blocks.push('</ul>\n');
  return pos;
}

function parseOrderedListBlock(src, len, pos, ls0, firstAfter, blocks, linkCtx) {
  let startNum = 0;
  for (let k = ls0; k < firstAfter - 2; k++) {
    startNum = startNum * 10 + (src.charCodeAt(k) - 48);
  }
  blocks.push(startNum !== 1 ? `<ol start="${startNum}">\n` : '<ol>\n');
  let itemSingleStart = -1;
  let itemSingleEnd = -1;
  let itemLines = null;

  while (pos < len) {
    if (src.charCodeAt(pos) === 10) {
      pos++;
      break;
    }
    const nl = src.indexOf('\n', pos);
    const ls = pos;
    const le = nl === -1 ? len : nl;
    const nextPos = nl === -1 ? len + 1 : nl + 1;

    const after = src.charCodeAt(ls) >= 48 && src.charCodeAt(ls) <= 57 ? matchOrderedMarker(src, ls, le) : -1;
    if (after !== -1) {
      if (itemSingleStart !== -1) {
        blocks.push('<li>', renderInlineRange(src, itemSingleStart, itemSingleEnd, linkCtx), '</li>\n');
        itemSingleStart = -1;
      } else if (itemLines !== null) {
        const joined = itemLines.join('\n');
        blocks.push('<li>', renderInlineRange(joined, 0, joined.length, linkCtx), '</li>\n');
        itemLines = null;
      }
      let ts = after;
      while (ts < le && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
      let te = le;
      while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
      itemSingleStart = ts;
      itemSingleEnd = te;
      pos = nextPos;
    } else if (isContinuedRange(src, ls, le)) {
      let ts = ls;
      while (ts < le && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
      let te = le;
      while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
      if (itemLines === null) {
        itemLines = [src.slice(itemSingleStart, itemSingleEnd), src.slice(ts, te)];
        itemSingleStart = -1;
      } else {
        itemLines.push(src.slice(ts, te));
      }
      pos = nextPos;
    } else {
      break;
    }
  }
  if (itemSingleStart !== -1) {
    blocks.push('<li>', renderInlineRange(src, itemSingleStart, itemSingleEnd, linkCtx), '</li>\n');
  } else if (itemLines !== null) {
    const joined = itemLines.join('\n');
    blocks.push('<li>', renderInlineRange(joined, 0, joined.length, linkCtx), '</li>\n');
  }
  blocks.push('</ol>\n');
  return pos;
}

function parseBlockquoteBlock(src, len, pos, blocks, linkCtx) {
  let qSingleStart = -1;
  let qSingleEnd = -1;
  let qLines = null;
  while (pos < len) {
    if (src.charCodeAt(pos) !== 62) {
      if (src.charCodeAt(pos) === 10) pos++;
      break;
    }
    const nl = src.indexOf('\n', pos);
    const ls = pos;
    const le = nl === -1 ? len : nl;
    pos = nl === -1 ? len + 1 : nl + 1;
    let ts = ls + 1;
    if (ts < le && src.charCodeAt(ts) === 32) ts++;
    while (ts < le && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
    let te = le;
    while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
    if (ts < te) {
      if (qLines !== null) {
        qLines.push(src.slice(ts, te));
      } else if (qSingleStart === -1) {
        qSingleStart = ts;
        qSingleEnd = te;
      } else {
        qLines = [src.slice(qSingleStart, qSingleEnd), src.slice(ts, te)];
      }
    }
  }
  if (qLines !== null) {
    const joined = qLines.join('\n');
    blocks.push('<blockquote>\n<p>', renderInlineRange(joined, 0, joined.length, linkCtx), '</p>\n</blockquote>\n');
  } else if (qSingleStart !== -1) {
    blocks.push('<blockquote>\n<p>', renderInlineRange(src, qSingleStart, qSingleEnd, linkCtx), '</p>\n</blockquote>\n');
  } else {
    blocks.push('<blockquote>\n</blockquote>\n');
  }
  return pos;
}

function renderMarkdownDoc(src, linkCtx) {
  const len = src.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let pos = 0;

  while (pos < len) {
    while (pos < len && src.charCodeAt(pos) === 10) pos++;
    if (pos >= len) break;

    let nl = src.indexOf('\n', pos);
    let ls = pos;
    let le = nl === -1 ? len : nl;
    let nextPos = nl === -1 ? len + 1 : nl + 1;

    const c0 = src.charCodeAt(ls);
    if ((c0 === 32 || c0 === 9) && isBlankRange(src, ls + 1, le)) {
      pos = nextPos;
      continue;
    }
    if (c0 === 96) {
      const langEnd = matchFenceOpen(src, ls, le);
      if (langEnd !== -1) {
        pos = parseFenceBlock(src, len, ls, langEnd, nextPos, blocks);
        continue;
      }
    }
    if (c0 === 35) {
      const depth = matchHeadingRange(src, ls, le);
      if (depth !== 0) {
        parseHeadingBlock(src, ls, le, depth, ids, toc, blocks, linkCtx);
        pos = nextPos;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (isHrRange(src, ls, le)) {
        blocks.push('<hr>\n');
        pos = nextPos;
        continue;
      }
      if (ls + 1 < le && src.charCodeAt(ls + 1) === 32 && hasNoLineSep(src, ls + 2, le)) {
        pos = parseBulletListBlock(src, len, pos, blocks, linkCtx);
        continue;
      }
    }
    if (c0 === 62) {
      pos = parseBlockquoteBlock(src, len, pos, blocks, linkCtx);
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const firstAfter = matchOrderedMarker(src, ls, le);
      if (firstAfter !== -1) {
        pos = parseOrderedListBlock(src, len, pos, ls, firstAfter, blocks, linkCtx);
        continue;
      }
    }

    // Paragraph (contiguous slice fast path + instant \n\n break)
    const paraStart = ls;
    let paraEnd = le;
    let clean = true;
    const fc = src.charCodeAt(ls);
    const lc = src.charCodeAt(le - 1);
    let pLines = null;
    if (fc === 32 || fc === 9 || lc === 32 || lc === 9) {
      clean = false;
      let ts = ls;
      while (ts < le && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
      let te = le;
      while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
      pLines = [src.slice(ts, te)];
    }
    pos = nextPos;
    while (pos < len) {
      if (src.charCodeAt(pos) === 10) {
        pos++;
        break;
      }
      nl = src.indexOf('\n', pos);
      ls = pos;
      le = nl === -1 ? len : nl;
      if (isParagraphBreakRange(src, ls, le)) break;
      pos = nl === -1 ? len + 1 : nl + 1;
      const cStart = src.charCodeAt(ls);
      const cEnd = src.charCodeAt(le - 1);
      if (clean && cStart !== 32 && cStart !== 9 && cEnd !== 32 && cEnd !== 9) {
        paraEnd = le;
      } else {
        if (clean) {
          clean = false;
          pLines = [src.slice(paraStart, paraEnd)];
        }
        let ts = ls;
        while (ts < le && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
        let te = le;
        while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
        pLines.push(src.slice(ts, te));
      }
    }
    let html;
    if (clean) {
      html = renderInlineRange(src, paraStart, paraEnd, linkCtx);
    } else {
      const joined = pLines.join('\n');
      html = renderInlineRange(joined, 0, joined.length, linkCtx);
    }
    if (excerpt === null) excerpt = html;
    blocks.push('<p>', html, '</p>\n');
  }

  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------- Main build ----------------

export function run(input) {
  const templates = new Map();
  const reportLines = [];
  const tplNames = Object.keys(input.templates).sort(cmpCodeUnits);
  for (let i = 0; i < tplNames.length; i++) {
    const name = tplNames[i];
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TplParseError)) throw err;
      reportLines.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1 + 2. Sort files, separate statics, parse & validate front matter in one pass
  const sortedFiles = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const kept = [];
  const statics = [];
  for (let i = 0; i < sortedFiles.length; i++) {
    const f = sortedFiles[i];
    const path = f.path;
    const pLen = path.length;
    if (
      pLen >= 3 &&
      path.charCodeAt(pLen - 3) === 46 &&
      path.charCodeAt(pLen - 2) === 109 &&
      path.charCodeAt(pLen - 1) === 100
    ) {
      const content = f.content;
      const text = content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n');
      const fm = parseFrontMatter(text);
      if (fm.error !== undefined) {
        reportLines.push(`refused ${path}: ${fm.error}`);
        continue;
      }
      const data = fm.data;
      const isPost = path.startsWith('posts/');
      if (!isPost) {
        if (path.startsWith('tags/')) {
          reportLines.push(`refused ${path}: tags/ is the generator's own`);
          continue;
        }
        if (path.startsWith('page/')) {
          reportLines.push(`refused ${path}: page/ is the generator's own`);
          continue;
        }
      } else if (!Object.hasOwn(data, 'date')) {
        reportLines.push(`refused ${path}: a post needs a date`);
        continue;
      }
      const layout = data.layout ?? (isPost ? 'post' : 'page');
      if (!templates.has(layout)) {
        reportLines.push(`refused ${path}: layout "${layout}" is no template that parses`);
        continue;
      }
      if (data.draft === true) {
        reportLines.push(`draft ${path}`);
        continue;
      }
      kept.push({
        path,
        data,
        body: fm.body,
        post: isPost,
        layout,
        slug: '',
        outDir: '',
        url: '',
        html: '',
        toc: null,
        excerpt: '',
        newer: null,
        older: null,
        tagRefs: null,
        card: null,
        link: null,
      });
    } else {
      statics.push(f);
    }
  }

  // 3. Permalinks
  const takenByDir = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : parentDir(s.path);
    let used = takenByDir.get(dir);
    if (used === undefined) {
      used = new Set(dir === '' ? RESERVED_ROOT : undefined);
      takenByDir.set(dir, used);
    }
    const slug = allocateSlug(s.data.slug ?? slugify(s.data.title), used);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown rendering
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  const dirPartsCache = new Map();
  dirPartsCache.set('', []);
  const linkCtx = { sourcePath: '', dirParts: null, bySource, staticPaths, base, broken };

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = parentDir(s.path);
    let dp = dirPartsCache.get(dir);
    if (dp === undefined) {
      dp = dir.split('/');
      dirPartsCache.set(dir, dp);
    }
    linkCtx.sourcePath = s.path;
    linkCtx.dirParts = dp;
    const md = renderMarkdownDoc(s.body, linkCtx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections
  const posts = [];
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].post) posts.push(kept[i]);
  }
  posts.sort((a, b) =>
    (b.data.date < a.data.date ? -1 : b.data.date > a.data.date ? 1 : 0) ||
    (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  );
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i === 0 ? null : posts[i - 1];
    posts[i].older = i === posts.length - 1 ? null : posts[i + 1];
  }

  // 6. Tags
  const tagSlugCache = new Map();
  const slugifyTag = (name) => {
    let sl = tagSlugCache.get(name);
    if (sl === undefined) {
      sl = slugify(name);
      tagSlugCache.set(name, sl);
    }
    return sl;
  };
  const tagsBySlug = new Map();
  const dedupeTags = (rawTags) => {
    if (rawTags === undefined || rawTags.length === 0) return null;
    const seen = new Set();
    const out = [];
    for (let i = 0; i < rawTags.length; i++) {
      const name = rawTags[i];
      const sl = slugifyTag(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push({ name, slug: sl });
      }
    }
    return out;
  };

  const EMPTY_TAGS = [];

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const own = dedupeTags(p.data.tags);
    if (own === null) {
      p.tagRefs = EMPTY_TAGS;
      continue;
    }
    const views = new Array(own.length);
    for (let j = 0; j < own.length; j++) {
      const { name, slug } = own[j];
      let tag = tagsBySlug.get(slug);
      if (tag === undefined) {
        const url = `${base}/tags/${slug}/`;
        tag = { name, slug, url, posts: [], view: { name, slug, url } };
        tagsBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      views[j] = tag.view;
    }
    p.tagRefs = views;
  }

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const own = dedupeTags(s.data.tags);
    if (own === null) {
      s.tagRefs = EMPTY_TAGS;
      continue;
    }
    const views = new Array(own.length);
    for (let j = 0; j < own.length; j++) {
      const { name, slug } = own[j];
      const existing = tagsBySlug.get(slug);
      views[j] = existing !== undefined ? existing.view : { name, slug, url: '' };
    }
    s.tagRefs = views;
  }

  const sortedTags = Array.from(tagsBySlug.values()).sort(
    (a, b) => b.posts.length - a.posts.length || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  );

  // 7. Layouts & rendering
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const date = p.data.date ?? '';
    const dateLong = p.data.date === undefined ? '' : formatLongDate(p.data.date);
    const card = {
      title: p.data.title,
      url: p.url,
      date,
      date_long: dateLong,
      summary: p.data.summary ?? '',
      excerpt: p.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(p.body) / 200)),
      tags: p.tagRefs,
    };
    p.card = card;
    p.link = { title: card.title, url: card.url, date: card.date, date_long: card.date_long };
  }

  const siteVar = { title: input.site.title, base_url: base };
  const allTagsVar = sortedTags.map((t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
  }));
  const recentSlice = posts.slice(0, input.site.recent);
  const recentVar = new Array(recentSlice.length);
  for (let i = 0; i < recentSlice.length; i++) {
    recentVar[i] = recentSlice[i].card;
  }

  const sharedItemCaches = new Map();
  const baseBindings = () => {
    const b = Object.create(null);
    b.site = { known: true, value: siteVar };
    b.tags = { known: true, value: allTagsVar };
    b.recent = { known: true, value: recentVar };
    return b;
  };

  const pagePrograms = new Map();
  const getPageProgram = (layoutName) => {
    let prog = pagePrograms.get(layoutName);
    if (prog === undefined) {
      const b = baseBindings();
      b.page = { known: false, slot: 0, truthyObj: true };
      prog = specializeTemplate(templates.get(layoutName), templates, b, sharedItemCaches);
      pagePrograms.set(layoutName, prog);
    }
    return prog;
  };

  const output = {};
  const outBuf = [];

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const prog = getPageProgram(s.layout);
    let page;
    if (s.post) {
      const card = s.card;
      page = {
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
        newer: s.newer === null ? null : s.newer.link,
        older: s.older === null ? null : s.older.link,
        is_post: true,
      };
    } else {
      const date = s.data.date ?? '';
      page = {
        title: s.data.title,
        url: s.url,
        date,
        date_long: s.data.date === undefined ? '' : formatLongDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: prog.usesReadingMinutes ? Math.max(1, Math.ceil(countWords(s.body) / 200)) : 1,
        tags: s.tagRefs,
        slug: s.slug,
        content: s.html,
        toc: s.toc,
        newer: null,
        older: null,
        is_post: false,
      };
    }
    prog.slots[0] = page;
    outBuf.length = 0;
    runOpsInto(prog.ops, prog.slots, outBuf);
    output[`${s.outDir}/index.html`] = outBuf.join('');
  }

  const perPage = input.site.per_page;
  const totalIndexPages = Math.max(1, Math.ceil(posts.length / perPage));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  let idxProg = null;
  for (let k = 1; k <= totalIndexPages; k++) {
    const slice = posts.slice((k - 1) * perPage, k * perPage);
    const indexTpl = templates.get('index');
    if (indexTpl === undefined) continue;
    if (idxProg === null) {
      const b = baseBindings();
      b.posts = { known: false, slot: 0, truthyObj: false };
      b.pager = { known: false, slot: 1, truthyObj: true };
      idxProg = specializeTemplate(indexTpl, templates, b, sharedItemCaches);
    }
    const pagePosts = new Array(slice.length);
    for (let j = 0; j < slice.length; j++) pagePosts[j] = slice[j].card;
    idxProg.slots[0] = pagePosts;
    idxProg.slots[1] = {
      number: k,
      total: totalIndexPages,
      url: indexUrl(k),
      newer_url: k === 1 ? '' : indexUrl(k - 1),
      older_url: k === totalIndexPages ? '' : indexUrl(k + 1),
    };
    outBuf.length = 0;
    runOpsInto(idxProg.ops, idxProg.slots, outBuf);
    output[k === 1 ? 'index.html' : `page/${k}/index.html`] = outBuf.join('');
  }

  const tagTpl = templates.get('tag');
  if (tagTpl !== undefined) {
    const b = baseBindings();
    b.tag = { known: false, slot: 0, truthyObj: true };
    const tagProg = specializeTemplate(tagTpl, templates, b, sharedItemCaches);
    for (let i = 0; i < sortedTags.length; i++) {
      const t = sortedTags[i];
      const tPosts = new Array(t.posts.length);
      for (let j = 0; j < t.posts.length; j++) tPosts[j] = t.posts[j].card;
      tagProg.slots[0] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tPosts };
      outBuf.length = 0;
      runOpsInto(tagProg.ops, tagProg.slots, outBuf);
      output[`tags/${t.slug}/index.html`] = outBuf.join('');
    }
  }

  const tagsTpl = templates.get('tags');
  if (tagsTpl !== undefined) {
    const tagsProg = specializeTemplate(tagsTpl, templates, baseBindings(), sharedItemCaches);
    outBuf.length = 0;
    runOpsInto(tagsProg.ops, tagsProg.slots, outBuf);
    output['tags/index.html'] = outBuf.join('');
  }

  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) {
      reportLines.push(`shadowed ${f.path}: a built page has its path`);
    } else {
      output[f.path] = f.content;
    }
  }

  // 8. Report
  const allReport = reportLines.concat(Array.from(broken)).sort(cmpCodeUnits);
  const pageCount = kept.length - posts.length;
  allReport.push(`built ${pageCount} pages, ${posts.length} posts, ${sortedTags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${allReport.join('\n')}\n`;

  return output;
}
