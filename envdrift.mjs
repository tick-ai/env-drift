import { readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

class Fail extends Error {}

const EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const REGEX_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isWordCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}
function isSpace(ch) {
  return /\s/.test(ch);
}

function tokenize(src) {
  const n = src.length;
  const toks = [];
  const stack = [];
  let i = 0;
  if (src.startsWith('#!')) {
    while (i < n && src[i] !== '\n') i++;
  }

  // scan template text starting at i (just after a backtick or a closing `}` of ${ })
  // returns after pushing tokens; sets i
  function scanTemplate(fresh) {
    let esc = false;
    const start = i;
    for (;;) {
      if (i >= n) {
        toks.push({ t: 'tpl', simple: false });
        return;
      }
      const c = src[i];
      if (c === '\\') { esc = true; i += 2; continue; }
      if (c === '`') {
        const raw = src.slice(start, i);
        i++;
        toks.push({ t: 'tpl', simple: fresh && !esc, raw });
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        toks.push({ t: 'tpl', simple: false });
        toks.push({ t: 'tplopen' });
        stack.push(null);
        return;
      }
      i++;
    }
  }

  while (i < n) {
    const ch = src[i];
    const c = src.charCodeAt(i);
    if (isSpace(ch)) { i++; continue; }
    if (ch === '/') {
      const nx = src[i + 1];
      if (nx === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (nx === '*') {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      const prev = toks.length ? toks[toks.length - 1] : null;
      let regex;
      if (!prev) regex = true;
      else if (prev.t === 'punct') regex = !(prev.v === ')' || prev.v === ']' || prev.v === '}');
      else if (prev.t === 'tplopen') regex = true;
      else if (prev.t === 'word') regex = REGEX_WORDS.has(prev.v);
      else regex = false;
      if (regex) {
        i++;
        let inClass = false;
        while (i < n) {
          const d = src[i];
          if (d === '\n') break;
          if (d === '\\') { i += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < n && /[A-Za-z]/.test(src[i])) i++;
        toks.push({ t: 'regex' });
        continue;
      }
      toks.push({ t: 'punct', v: '/' });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let closed = false;
      let esc = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { esc = true; j += 2; continue; }
        if (d === '\n') break;
        if (d === ch) { closed = true; break; }
        j++;
      }
      const end = Math.min(j, n);
      toks.push({ t: 'str', closed, esc, v: closed ? src.slice(i + 1, j) : '' });
      i = closed ? j + 1 : end;
      continue;
    }
    if (ch === '`') {
      i++;
      scanTemplate(true);
      continue;
    }
    if (isWordCode(c) || (c > 127)) {
      let j = i;
      const startsNum = c >= 48 && c <= 57;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (isWordCode(d) || (d > 127 && !isSpace(src[j]))) { j++; continue; }
        if (startsNum && d === 46 && j + 1 < n) {
          const e = src.charCodeAt(j + 1);
          if (e >= 48 && e <= 57) { j++; continue; }
        }
        break;
      }
      if (j === i) { j = i + 1; }
      toks.push({ t: 'word', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9') {
      // number like .5
      let j = i + 1;
      while (j < n && isWordCode(src.charCodeAt(j))) j++;
      toks.push({ t: 'word', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '{') {
      stack.push(toks.length);
      toks.push({ t: 'punct', v: '{' });
      i++;
      continue;
    }
    if (ch === '}') {
      if (stack.length && stack[stack.length - 1] === null) {
        stack.pop();
        toks.push({ t: 'tplclose' });
        i++;
        scanTemplate(false);
        continue;
      }
      const open = stack.length ? stack.pop() : -1;
      toks.push({ t: 'punct', v: '}', open });
      i++;
      continue;
    }
    if (ch === '=') {
      if (src[i + 1] === '=') {
        const v = src[i + 2] === '=' ? '===' : '==';
        toks.push({ t: 'punct', v });
        i += v.length;
      } else if (src[i + 1] === '>') {
        toks.push({ t: 'punct', v: '=>' });
        i += 2;
      } else {
        toks.push({ t: 'punct', v: '=' });
        i++;
      }
      continue;
    }
    if (ch === '?' && src[i + 1] === '.' && !(src[i + 2] >= '0' && src[i + 2] <= '9')) {
      toks.push({ t: 'punct', v: '?.' });
      i += 2;
      continue;
    }
    toks.push({ t: 'punct', v: ch });
    i++;
  }
  return toks;
}

const isP = (t, v) => t !== undefined && t.t === 'punct' && t.v === v;
const isDot = (t) => isP(t, '.') || isP(t, '?.');

// returns index just after `process . env` starting at i (T[i] is process), or -1
function afterProcessEnv(T, i) {
  if (!isDot(T[i + 1])) return -1;
  const e = T[i + 2];
  if (e === undefined || e.t !== 'word' || e.v !== 'env') return -1;
  return i + 3;
}

function plainString(t) {
  if (t === undefined) return null;
  if (t.t === 'str' && t.closed && !t.esc) return t.v;
  return null;
}

function collect(src, out) {
  const T = tokenize(src);
  const len = T.length;
  for (let i = 0; i < len; i++) {
    const t = T[i];
    if (t.t !== 'word' || t.v !== 'process') continue;
    if (i > 0 && isDot(T[i - 1])) continue;
    const k = afterProcessEnv(T, i);
    if (k < 0) continue;
    // forms 1 and 2
    let a = T[k];
    if (isP(a, '.') || isP(a, '?.')) {
      if (isP(a, '?.') && isP(T[k + 1], '[')) {
        a = T[k + 1];
        const s = readBracket(T, k + 2);
        if (s !== null) out.add(s);
      } else {
        const w = T[k + 1];
        if (w !== undefined && w.t === 'word' && NAME_RE.test(w.v)) out.add(w.v);
      }
    } else if (isP(a, '[')) {
      const s = readBracket(T, k + 1);
      if (s !== null) out.add(s);
    } else {
      // form 3: preceded by `}` `=`
      if (i >= 2 && isP(T[i - 1], '=') && isP(T[i - 2], '}') && T[i - 2].open >= 0) {
        destructure(T, T[i - 2].open, i - 2, out);
      }
    }
  }
}

function readBracket(T, k) {
  // T[k] is the token after '['
  const s = T[k];
  if (s === undefined) return null;
  if (!isP(T[k + 1], ']')) return null;
  let v = null;
  if (s.t === 'str') v = plainString(s);
  else if (s.t === 'tpl' && s.simple) v = s.raw;
  else return null;
  if (v !== null && NAME_RE.test(v)) return v;
  return null;
}

function destructure(T, open, close, out) {
  let depth = 0;
  let entry = [];
  const entries = [];
  for (let j = open + 1; j < close; j++) {
    const t = T[j];
    if (t.t === 'tplopen') depth++;
    else if (t.t === 'tplclose') depth--;
    else if (t.t === 'punct') {
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') depth--;
      else if (t.v === ',' && depth === 0) {
        entries.push(entry);
        entry = [];
        continue;
      }
    }
    entry.push(t);
  }
  entries.push(entry);
  for (const e of entries) {
    const f = e[0];
    if (f === undefined) continue;
    if (f.t === 'punct') continue; // rest (...) or computed ([)
    if (f.t === 'word') {
      const nx = e[1];
      if (!NAME_RE.test(f.v)) continue;
      if (nx === undefined || isP(nx, ':') || isP(nx, '=')) out.add(f.v);
    } else if (f.t === 'str') {
      const v = plainString(f);
      if (v !== null && NAME_RE.test(v) && isP(e[1], ':')) out.add(v);
    }
  }
}

function walk(dir, files, isRoot) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Fail(`cannot read folder ${dir}`);
  }
  for (const d of ents) {
    if (d.isSymbolicLink()) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue;
      walk(p, files, false);
    } else if (d.isFile()) {
      if (EXTS.some((x) => d.name.endsWith(x))) files.push(p);
    }
  }
}

function listed(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const names = new Set();
  const re = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const m = re.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Fail('expected exactly one argument: the project folder');
  const dir = args[0];
  if (dir.startsWith('-')) throw new Fail('the argument must be a folder, not an option');
  let st;
  try {
    st = statSync(dir);
  } catch (e) {
    throw new Fail(`not an existing folder: ${dir}`);
  }
  if (!st.isDirectory()) throw new Fail(`not a folder: ${dir}`);
  const envPath = join(dir, '.env.example');
  let es;
  try {
    es = lstatSync(envPath);
  } catch (e) {
    throw new Fail(`no .env.example in ${dir}`);
  }
  if (!es.isFile()) throw new Fail(`.env.example is not a regular file in ${dir}`);
  let envText;
  try {
    envText = readFileSync(envPath).toString('utf8');
  } catch (e) {
    throw new Fail(`cannot read ${envPath}`);
  }
  const files = [];
  walk(dir, files, true);
  const used = new Set();
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f).toString('utf8');
    } catch (e) {
      throw new Fail(`cannot read ${f}`);
    }
    collect(text, used);
  }
  const have = listed(envText);
  const missing = [...used].filter((x) => !have.has(x)).sort();
  const stale = [...have].filter((x) => !used.has(x)).sort();
  if (!missing.length && !stale.length) return `in sync: ${used.size}\n`;
  const lines = missing.map((x) => `missing: ${x}\n`).concat(stale.map((x) => `stale: ${x}\n`));
  return { out: lines.join('') };
}

try {
  const r = main();
  if (typeof r === 'string') {
    process.stdout.write(r);
    process.exitCode = 0;
  } else {
    process.stdout.write(r.out);
    process.exitCode = 1;
  }
} catch (e) {
  const msg = e instanceof Fail ? e.message : `unexpected error: ${e && e.message}`;
  process.stderr.write(`envdrift: ${msg.replace(/\n/g, ' ')}\n`);
  process.exitCode = 2;
}
