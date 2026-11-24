// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all ten sections of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// matching lines at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A
// patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move pairs, in the order the edits made them, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- SPEC.md section 3: a file's lines under its own line break ----

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- SPEC.md section 5: matching lines ----

function stripLead(s: string): string {
  return s.replace(/^[ \t]+/, '');
}
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripLead(stripTrail(a)) === stripLead(stripTrail(b));
}

/** The first tier at which `oldLines` occurs in `lines` at or after `from`, and every such position. */
function occurrences(
  lines: string[],
  oldLines: string[],
  from: number,
  strict: boolean,
  mustEndAt?: number,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos: number[] = [];
    for (let i = from; i + oldLines.length <= lines.length; i++) {
      if (mustEndAt !== undefined && i + oldLines.length !== mustEndAt) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (!lineEq(lines[i + j]!, oldLines[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier where one is (single lines). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

interface ReplItem {
  file: boolean;
  oIndex: number;
  text: string;
}

/**
 * The lines that replace a match at `pos`: context items are the file's own matched lines, the rest are the
 * patch's lines, re-indented at tier 2 (section 5).
 */
function buildReplacement(fileLines: string[], pos: number, oLines: string[], items: ReplItem[], tier: number): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = oLines.length > 0 ? leadWs(oLines[0]!) : '';
  const out: string[] = [];
  for (const it of items) {
    if (it.file) {
      out.push(fileLines[pos + it.oIndex]!);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

// ---- Body lines, shared by unified hunks (section 6) and V4A chunks (section 8) ----

interface BodyParts {
  oLines: string[];
  items: ReplItem[];
  /** A `\` line follows the body's last context or `+` line. */
  backslash: boolean;
}

function parseBody(body: string[]): BodyParts {
  const oLines: string[] = [];
  const items: ReplItem[] = [];
  let lastCtxOrPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '' || l.startsWith(' ')) {
      oLines.push(l === '' ? '' : l.slice(1));
      items.push({ file: true, oIndex: oLines.length - 1, text: '' });
      lastCtxOrPlus = k;
    } else if (l.startsWith('-')) {
      oLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      items.push({ file: false, oIndex: -1, text: l.slice(1) });
      lastCtxOrPlus = k;
    }
    // '\' lines are not part of O or N; they only matter through `backslash` below.
  }
  const backslash =
    lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]!.startsWith('\\');
  return { oLines, items, backslash };
}

// ---- SPEC.md section 6: unified diffs ----

interface Hunk {
  a: number;
  c: number;
  body: string[];
}

interface Section {
  oldPath: string | undefined;
  newPath: string | undefined;
  creation: boolean;
  deletion: boolean;
  hasPair: boolean;
  seenHunk: boolean;
  hunks: Hunk[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const gitRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const hdrPath = (rest: string): string => stripPrefix(rest.split('\t')[0]!.trim());
  const sections: Section[] = [];
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    let sec: Section;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = {
        oldPath: stripPrefix(m[1]!),
        newPath: stripPrefix(m[2]!),
        creation: false,
        deletion: false,
        hasPair: false,
        seenHunk: false,
        hunks: [],
      };
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = {
        oldPath: hdrPath(line.slice(4)),
        newPath: hdrPath(lines[i + 1]!.slice(4)),
        creation: false,
        deletion: false,
        hasPair: true,
        seenHunk: false,
        hunks: [],
      };
      i += 2;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    sections.push(sec);
    let hunk: Hunk | null = null;
    const endBody = (): void => {
      if (hunk !== null) {
        while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
        sec.hunks.push(hunk);
        hunk = null;
      }
    };
    while (i < n) {
      const l = lines[i]!;
      if (hunk !== null) {
        if (l.startsWith('diff --git ')) {
          endBody();
          break;
        }
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
          endBody();
          break;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          hunk.body.push(l);
          i++;
          continue;
        }
        endBody();
        continue;
      }
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!sec.hasPair && !sec.seenHunk) {
          sec.oldPath = hdrPath(l.slice(4));
          sec.newPath = hdrPath(lines[i + 1]!.slice(4));
          sec.hasPair = true;
          i += 2;
          continue;
        }
        break;
      }
      if (l.startsWith('--- ')) {
        if (!sec.seenHunk) throw new Exit2(`error: parse ${i + 2}`);
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = hunkRe.exec(l);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        hunk = { a: parseInt(m[1]!, 10), c: parseInt(m[3]!, 10), body: [] };
        sec.seenHunk = true;
        i++;
        continue;
      }
      if (!sec.seenHunk) {
        if (l.startsWith('+++ ')) {
          sec.newPath = hdrPath(l.slice(4));
          i++;
          continue;
        }
        if (l.startsWith('rename from ')) {
          sec.oldPath = stripPrefix(l.slice(12).trim());
          i++;
          continue;
        }
        if (l.startsWith('rename to ')) {
          sec.newPath = stripPrefix(l.slice(10).trim());
          i++;
          continue;
        }
        if (l.startsWith('new file mode')) {
          sec.creation = true;
          i++;
          continue;
        }
        if (l.startsWith('deleted file mode')) {
          sec.deletion = true;
          i++;
          continue;
        }
      }
      i++;
    }
    endBody();
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let model = parseFile(text);
  let d = 0;
  for (const hunk of hunks) {
    const { oLines, items, backslash } = parseBody(hunk.body);
    if (oLines.length > 0) {
      const occ = occurrences(model.lines, oLines, 0, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = occ.pos[0]!;
      for (const p of occ.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const repl = buildReplacement(model.lines, best, oLines, items, occ.tier);
      const atEnd = best + oLines.length === model.lines.length;
      model = {
        br: model.br,
        lines: [...model.lines.slice(0, best), ...repl, ...model.lines.slice(best + oLines.length)],
        final: atEnd ? !backslash : model.final,
      };
      d += items.length - oLines.length;
    } else {
      const insPos = Math.max(0, Math.min(hunk.a + d, model.lines.length));
      const repl = items.map((it) => it.text);
      const atEnd = insPos === model.lines.length;
      model = {
        br: model.br,
        lines: [...model.lines.slice(0, insPos), ...repl, ...model.lines.slice(insPos)],
        final: atEnd ? !backslash : model.final,
      };
      d += repl.length;
    }
  }
  return renderFile(model);
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreation = sec.creation || oldP === '/dev/null';
    const isDeletion = !isCreation && (sec.deletion || newP === '/dev/null');
    if (isCreation) {
      const np = newP ?? oldP;
      if (np === undefined) throw new Fail('unsafe', '');
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plusLines: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const hunk of sec.hunks) {
        hunk.body.forEach((l, k) => {
          if (l.startsWith('+')) {
            plusLines.push(l.slice(1));
            lastPlus = { hunk, idx: k };
          }
        });
      }
      let backslash = false;
      if (lastPlus !== null) {
        const b = lastPlus.hunk.body;
        backslash = b[lastPlus.idx + 1] !== undefined && b[lastPlus.idx + 1]!.startsWith('\\');
      }
      tree.now.set(np, plusLines.length === 0 ? '' : plusLines.join('\n') + (backslash ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const op = oldP ?? newP;
      if (op === undefined) throw new Fail('unsafe', '');
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const isMove = oldP !== undefined && newP !== undefined && oldP !== newP;
    if (isMove) {
      if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
      if (!safe(newP!)) throw new Fail('unsafe', newP!);
      const text = tree.get(oldP!);
      if (text === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = applyHunks(text, sec.hunks, strict, oldP!);
      tree.now.set(oldP!, null);
      tree.now.set(newP!, out);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const p = oldP ?? newP;
    if (p === undefined) throw new Fail('unsafe', '');
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, sec.hunks, strict, p));
  };
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const model = parseFile(text);
    const occ = occurrences(model.lines, oldLines, 0, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.pos[0]!;
    const items: ReplItem[] = newLines.map((t) => ({ file: false, oIndex: -1, text: t }));
    const repl = buildReplacement(model.lines, pos, oldLines, items, occ.tier);
    tree.now.set(
      path,
      renderFile({
        br: model.br,
        lines: [...model.lines.slice(0, pos), ...repl, ...model.lines.slice(pos + oldLines.length)],
        final: model.final,
      }),
    );
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eqIdx), lines.slice(eqIdx + 1, repIdx), strict));
    prevReplaceEnd = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

// ---- SPEC.md section 8: V4A patches ----

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE_TO = '*** Move to: ';

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: Array<{ text: string; no: number }>;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let k = 0; k < n; k++) {
    if (!blank(lines[k]!)) {
      first = k;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let k = first + 1; k < last; k++) {
    const l = lines[k]!;
    const no = k + 1;
    if (l.startsWith(V4A_ADD)) {
      cur = { kind: 'add', path: l.slice(V4A_ADD.length).trim(), lineNo: no, raw: [] };
      sections.push(cur);
      continue;
    }
    if (l.startsWith(V4A_DELETE)) {
      cur = { kind: 'delete', path: l.slice(V4A_DELETE.length).trim(), lineNo: no, raw: [] };
      sections.push(cur);
      continue;
    }
    if (l.startsWith(V4A_UPDATE)) {
      cur = { kind: 'update', path: l.slice(V4A_UPDATE.length).trim(), lineNo: no, raw: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    cur.raw.push({ text: l, no });
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (const r of s.raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (s.kind === 'delete') {
      if (s.raw.length > 0) throw new Exit2(`error: parse ${s.raw[0]!.no}`);
      edits.push((tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      });
    } else {
      edits.push(v4aUpdateEdit(s, strict));
    }
  }
  return edits;
}

function v4aUpdateEdit(s: VSection, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  const raw = s.raw;
  if (raw.length > 0 && raw[0]!.text.startsWith(V4A_MOVE_TO)) {
    moveTo = raw[0]!.text.slice(V4A_MOVE_TO.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  let chunkOpen = false;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(curChunk);
      chunkOpen = true;
      continue;
    }
    if (l === '*** End of File') {
      if (!chunkOpen || curChunk === null) throw new Exit2(`error: parse ${r.no}`);
      curChunk.eof = true;
      chunkOpen = false;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (!chunkOpen) {
        if (chunks.length === 0) {
          curChunk = { anchor: null, eof: false, body: [] };
          chunks.push(curChunk);
          chunkOpen = true;
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      curChunk!.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    const text = tree.get(s.path);
    if (text === null) throw new Fail('missing', s.path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const model = parseFile(text);
    let lines = model.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const aPos = findAnchor(lines, chunk.anchor, cursor, strict);
        if (aPos === null) throw new Fail('no-match', s.path);
        cursor = aPos + 1;
      }
      const { oLines, items } = parseBody(chunk.body);
      if (oLines.length === 0) {
        const insPos = chunk.eof ? lines.length : cursor;
        const repl = items.map((it) => it.text);
        lines = [...lines.slice(0, insPos), ...repl, ...lines.slice(insPos)];
        cursor = insPos + repl.length;
      } else {
        const occ = occurrences(lines, oLines, cursor, strict, chunk.eof ? lines.length : undefined);
        if (occ === null) throw new Fail('no-match', s.path);
        const pos = occ.pos[0]!;
        const repl = buildReplacement(lines, pos, oLines, items, occ.tier);
        lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oLines.length)];
        cursor = pos + repl.length;
      }
    }
    const out = renderFile({ br: model.br, lines, final: model.final });
    if (moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([s.path, moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---- SPEC.md section 9: JSON edits (starter) ----

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
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---- SPEC.md sections 1, 2 and 10: invocation, output, atomicity ----

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface DiffRow {
    path: string;
    was: string | null;
    now: string | null;
  }
  const diffs: DiffRow[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    diffs.push({ path: p, was, now });
  }
  interface OutRow {
    key: string;
    line: string;
    ops: Array<{ path: string; now: string | null }>;
  }
  const outRows: OutRow[] = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const dOld = diffs.find((x) => x.path === oldP);
    const dNew = diffs.find((x) => x.path === newP);
    if (
      dOld !== undefined &&
      dNew !== undefined &&
      dOld.was !== null &&
      dOld.now === null &&
      dNew.was === null &&
      dNew.now !== null &&
      !used.has(oldP) &&
      !used.has(newP)
    ) {
      used.add(oldP);
      used.add(newP);
      outRows.push({
        key: newP,
        line: `R ${oldP} -> ${newP}`,
        ops: [
          { path: oldP, now: null },
          { path: newP, now: dNew.now },
        ],
      });
    }
  }
  for (const x of diffs) {
    if (used.has(x.path)) continue;
    outRows.push({
      key: x.path,
      line: `${x.was === null ? 'A' : x.now === null ? 'D' : 'M'} ${x.path}`,
      ops: [{ path: x.path, now: x.now }],
    });
  }
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = outRows.map((r) => r.line);
  if (!check) {
    for (const r of outRows) {
      for (const op of r.ops) {
        if (op.now === null) rmSync(op.path, { force: true });
        else {
          mkdirSync(dirname(op.path), { recursive: true });
          writeFileSync(op.path, op.now);
        }
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
