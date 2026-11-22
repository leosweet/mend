// mend: one patch tool for every AI edit format (SPEC.md).
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** An exit-2 outcome: one line of stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with /,
    holds no backslash, and none of its /-separated segments is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as lines plus its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  ends: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

/** The leading spaces and tabs of a line. */
function leadingWS(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
    the rest read from disk (cached in `orig`). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit: applies to the tree, or throws Fail. Returns the move it made, if any. */
type Edit = (tree: Tree) => { old: string; nw: string } | null;

/** SPEC.md section 5: the positions where O occurs in lines at one tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const norm = (s: string): string =>
    tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  const on = o.map(norm);
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(lines[i + j]!) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at or after `from`. */
function firstTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: its text, and the index into O when it is a context line, else null. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** SPEC.md section 5: the lines N writes when it replaces O at `pos` in `fileLines`.
    A context line is written as the file's own matched line, never the patch's.
    At tier 2 every other line is re-indented from O's first line's leading
    whitespace to the file's first matched line's. */
function replacementLines(nw: NewLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return nw.map((e) => (e.ctx !== null ? fileLines[pos + e.ctx]! : e.text));
  const f = leadingWS(fileLines[pos] ?? '');
  const p = leadingWS(o[0] ?? '');
  return nw.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx]!;
    const t = e.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/* ---- Section 6: unified diffs ---- */

interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNL: boolean;
}

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface Section {
  diffX: string | null;
  diffY: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    diffX: null, diffY: null, hdrOld: null, hdrNew: null, hasPair: false,
    renameFrom: null, renameTo: null, create: false, del: false, hunks: [],
  };
}

/** The path a `--- ` or `+++ ` line names: text after the four characters, up to the
    first tab, with surrounding spaces removed; /dev/null means no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseHeader(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  while (i < n) {
    const h = lines[i]!;
    if (h.startsWith('@@')) return i;
    if (h.startsWith('diff --git ')) return i;
    if (h.startsWith('--- ')) {
      if (i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
        sec.hdrOld = headerPath(h);
        sec.hdrNew = headerPath(lines[i + 1]!);
        sec.hasPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (h.startsWith('rename from ')) {
      sec.renameFrom = h.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (h.startsWith('rename to ')) {
      sec.renameTo = h.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (h.startsWith('new file mode')) {
      sec.create = true;
      i += 1;
      continue;
    }
    if (h.startsWith('deleted file mode')) {
      sec.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function parseHunks(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  while (i < n) {
    const h = lines[i]!;
    if (h.startsWith('diff --git ')) return i;
    if (h.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) return i;
    if (h.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(h);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), entries: [] };
      i += 1;
      let lastWasEmpty = false;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          if (b[0] === '\\') {
            const last = hunk.entries[hunk.entries.length - 1];
            if (last !== undefined) last.noNL = true;
            lastWasEmpty = false;
          } else if (b === '') {
            hunk.entries.push({ kind: 'ctx', text: '', noNL: false });
            lastWasEmpty = true;
          } else if (b[0] === ' ') {
            hunk.entries.push({ kind: 'ctx', text: b.slice(1), noNL: false });
            lastWasEmpty = false;
          } else if (b[0] === '-') {
            hunk.entries.push({ kind: 'old', text: b.slice(1), noNL: false });
            lastWasEmpty = false;
          } else {
            hunk.entries.push({ kind: 'new', text: b.slice(1), noNL: false });
            lastWasEmpty = false;
          }
          i += 1;
        } else break;
      }
      if (lastWasEmpty) {
        while (hunk.entries.length > 0) {
          const last = hunk.entries[hunk.entries.length - 1]!;
          if (last.kind === 'ctx' && last.text === '') hunk.entries.pop();
          else break;
        }
      }
      sec.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  return i;
}

/** The hunks of a section, applied in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NewLine[] = [];
    for (const e of h.entries) {
      if (e.kind === 'ctx') {
        N.push({ text: e.text, ctx: O.length });
        O.push(e.text);
      } else if (e.kind === 'old') {
        O.push(e.text);
      } else {
        N.push({ text: e.text, ctx: null });
      }
    }
    if (O.length === 0 && N.length === 0) continue;
    let lastNoNL = false;
    for (let k = h.entries.length - 1; k >= 0; k -= 1) {
      const e = h.entries[k]!;
      if (e.kind === 'ctx' || e.kind === 'new') {
        lastNoNL = e.noNL;
        break;
      }
    }
    if (O.length > 0) {
      const found = firstTier(f.lines, O, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const runsToEnd = best + O.length === f.lines.length;
      const repl = replacementLines(N, O, f.lines, best, found.tier);
      f.lines.splice(best, O.length, ...repl);
      if (runsToEnd) f.ends = !lastNoNL;
      d += N.length - O.length;
    } else {
      const idx = Math.max(0, Math.min(h.a + d, f.lines.length));
      f.lines.splice(idx, 0, ...N.map((e) => e.text));
      if (idx === f.lines.length) f.ends = !lastNoNL;
      d += N.length;
    }
  }
  return renderFile(f);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.hasPair ? sec.hdrOld : sec.renameFrom ?? sec.diffX;
  const newP = sec.hasPair ? sec.hdrNew : sec.renameTo ?? sec.diffY;
  const isCreate = oldP === null || sec.create;
  const isDelete = newP === null || sec.del;
  if (isCreate) {
    return (tree) => {
      const p = newP ?? '/dev/null';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastNoNL = false;
      let hasPlus = false;
      for (const h of sec.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'new') {
            plus.push(e.text);
            lastNoNL = e.noNL;
            hasPlus = true;
          }
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (hasPlus && !lastNoNL ? '\n' : '');
      tree.now.set(p, text);
      return null;
    };
  }
  if (isDelete) {
    return (tree) => {
      const p = oldP ?? '/dev/null';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return null;
    };
  }
  if (oldP !== newP) {
    const oldPath = oldP!;
    const newPath = newP!;
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const after = applyHunks(before, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, after);
      return { old: oldPath, nw: newPath };
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
    return null;
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  const isSectionStart = (j: number): boolean =>
    j < n && lines[j]!.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ ');
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const cut = rest.indexOf(' b/');
      if (cut < 0) throw new Exit2(`error: parse ${i + 1}`);
      const sec = newSection();
      sec.diffX = rest.slice(2, cut);
      sec.diffY = rest.slice(cut + 3);
      if (sec.diffX === '' || sec.diffY === '') throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      i = parseHeader(lines, i, sec);
      i = parseHunks(lines, i, sec);
      sections.push(sec);
    } else if (isSectionStart(i)) {
      const sec = newSection();
      sec.hdrOld = headerPath(l);
      sec.hdrNew = headerPath(lines[i + 1]!);
      sec.hasPair = true;
      i += 2;
      i = parseHeader(lines, i, sec);
      i = parseHunks(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < n; j += 1) {
      const l = lines[j]!;
      const t = l.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '=======') {
        if (eq < 0) eq = j;
        continue;
      }
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return null;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = parseFile(before);
      const found = firstTier(f.lines, oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const nw: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      const repl = replacementLines(nw, oldLines, f.lines, pos, found.tier);
      f.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, renderFile(f));
      return null;
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
    return null;
  };
}

function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return null;
  };
}

function v4aUpdateEdit(p: string, raw: { text: string; no: number }[], updateNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < raw.length; idx += 1) {
    const { text, no } = raw[idx]!;
    if (text.startsWith('@@')) {
      flush();
      cur = { anchor: text.slice(2).trim(), eof: false, entries: [] };
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      flush();
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) cur = { anchor: null, eof: false, entries: [] };
      if (text === '') cur.entries.push({ kind: 'ctx', text: '', noNL: false });
      else if (text[0] === ' ') cur.entries.push({ kind: 'ctx', text: text.slice(1), noNL: false });
      else if (text[0] === '-') cur.entries.push({ kind: 'old', text: text.slice(1), noNL: false });
      else cur.entries.push({ kind: 'new', text: text.slice(1), noNL: false });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = firstTier(f.lines, [ch.anchor], cursor, strict);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.pos[0]! + 1;
      }
      const O: string[] = [];
      const N: NewLine[] = [];
      for (const e of ch.entries) {
        if (e.kind === 'ctx') {
          N.push({ text: e.text, ctx: O.length });
          O.push(e.text);
        } else if (e.kind === 'old') {
          O.push(e.text);
        } else {
          N.push({ text: e.text, ctx: null });
        }
      }
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...N.map((e) => e.text));
        cursor = at + N.length;
      } else {
        const found = firstTier(f.lines, O, cursor, strict);
        if (found === null) throw new Fail('no-match', p);
        let pos: number | null = null;
        for (const q of found.pos) {
          if (ch.eof && q + O.length !== f.lines.length) continue;
          pos = q;
          break;
        }
        if (pos === null) throw new Fail('no-match', p);
        const repl = replacementLines(N, O, f.lines, pos, found.tier);
        f.lines.splice(pos, O.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const after = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, after);
      return { old: p, nw: moveTo };
    }
    tree.now.set(p, after);
    return null;
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isSecStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i += 1;
      const raw: { text: string; no: number }[] = [];
      while (i < last && !isSecStart(lines[i]!)) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text[0] === '+') fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aAddEdit(p, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isSecStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateNo = i + 1;
      i += 1;
      const raw: { text: string; no: number }[] = [];
      while (i < last && !isSecStart(lines[i]!)) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      edits.push(v4aUpdateEdit(p, raw, updateNo, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ---- Section 9: JSON edits ---- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
      return null;
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLF = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLF(before);
      const old = toLF(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLF(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(f));
      return null;
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Section 4: detecting the format ---- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ---- Sections 1, 2 and 10: the command line, output, order and atomicity ---- */

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== null) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      moved.add(m.old);
      moved.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
