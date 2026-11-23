// mend applies patches to a tree of text files as specified in SPEC.md.
// Run with Node 22 as `node main.ts [options] [PATCH]`.
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
  readonly moves: [string, string][] = [];
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

type Edit = (tree: Tree) => void;

type Body = { kind: ' ' | '-' | '+'; text: string; noBreak?: boolean };

function parseError(index: number): never {
  throw new Exit2(`error: parse ${index + 1}`);
}

function splitFile(text: string) {
  const br = text.indexOf('\n') > 0 && text[text.indexOf('\n') - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { br, final, lines };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length ? lines.join(br) + (final ? br : '') : '';
}

const normalize = [
  (s: string) => s,
  (s: string) => s.replace(/[ \t]+$/, ''),
  (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, ''),
];

function matches(lines: string[], old: string[], strict: boolean, start = 0, eof = false) {
  const last = lines.length - old.length;
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const norm = normalize[tier];
    const wanted = old.map(norm);
    const positions: number[] = [];
    for (let i = eof ? Math.max(start, last) : start; i <= last; i++) {
      if (wanted.every((line, j) => line === norm(lines[i + j]))) positions.push(i);
    }
    if (positions.length) return { tier, positions };
  }
  return { tier: 0, positions: [] as number[] };
}

function replace(lines: string[], at: number, old: string[], body: Body[], tier: number): number {
  const indent = (s: string) => /^[ \t]*/.exec(s)![0];
  const from = indent(old[0] ?? '');
  const to = indent(lines[at] ?? '');
  const inserted: string[] = [];
  let offset = 0;
  for (const row of body) {
    if (row.kind === ' ') inserted.push(lines[at + offset++]);
    else if (row.kind === '-') offset++;
    else inserted.push(tier === 2 && !blank(row.text) && row.text.startsWith(from) ? to + row.text.slice(from.length) : row.text);
  }
  lines.splice(at, old.length, ...inserted);
  return inserted.length;
}

function fileEdit(oldPath: string | null, newPath: string | null, transform: (text: string) => string, move = false): Edit {
  return (tree) => {
    for (const path of [oldPath, newPath]) {
      if (path !== null && !safe(path)) throw new Fail('unsafe', path);
    }
    const before = oldPath === null ? '' : tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath!);
    if (newPath !== null && (move || newPath !== oldPath) && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const after = newPath === null ? '' : transform(before);
    if (oldPath !== null && oldPath !== newPath) tree.now.set(oldPath, null);
    if (newPath !== null) tree.now.set(newPath, after);
    if (oldPath !== null && newPath !== null && oldPath !== newPath) tree.moves.push([oldPath, newPath]);
  };
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let boundary = 0;
  let previous: string | undefined;
  const marker = (line: string) => line.trimEnd();
  for (let i = 0; i < lines.length; i++) {
    if (marker(lines[i]) !== '<<<<<<< SEARCH') continue;
    let path = previous;
    for (let j = i - 1; j >= boundary; j--) {
      const candidate = lines[j].trim();
      if (candidate && !candidate.startsWith('```')) { path = candidate; break; }
    }
    const separator = lines.findIndex((line, j) => j > i && marker(line) === '=======');
    const end = separator < 0 ? -1 : lines.findIndex((line, j) => j > separator && marker(line) === '>>>>>>> REPLACE');
    if (path === undefined || end < 0) parseError(i);
    const target = path;
    const old = lines.slice(i + 1, separator);
    const added = lines.slice(separator + 1, end);
    edits.push(fileEdit(old.length ? target : null, target, (text) => {
      if (!old.length) return joinFile(added, '\n', true);
      const file = splitFile(text);
      const { tier, positions } = matches(file.lines, old, strict);
      if (!positions.length) throw new Fail('no-match', target);
      if (positions.length > 1) throw new Fail('ambiguous', target);
      const body: Body[] = [...old.map((text) => ({ kind: '-' as const, text })), ...added.map((text) => ({ kind: '+' as const, text }))];
      replace(file.lines, positions[0], old, body, tier);
      return joinFile(file.lines, file.br, file.final);
    }));
    previous = path;
    boundary = end + 1;
    i = end;
  }
  return edits;
}

function bodyLine(line: string): Body | undefined {
  if (line === '') return { kind: ' ', text: '' };
  const kind = line[0];
  if (kind === ' ' || kind === '+' || kind === '-') return { kind, text: line.slice(1) };
}

const v4Header = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function v4Edits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') parseError(Math.max(first, 0));
  let last = lines.length - 1;
  while (last > first && blank(lines[last])) last--;
  if (lines[last].trim() !== '*** End Patch') parseError(lines.length);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) { i++; continue; }
    const header = i;
    const match = v4Header.exec(lines[i++]);
    if (!match) parseError(header);
    const [, action, name] = match;
    const path = name.trim();
    let next = i;
    while (next < last && !v4Header.test(lines[next])) next++;
    let end = next;
    while (end > i && blank(lines[end - 1])) end--;
    if (action === 'Add File') {
      const added: string[] = [];
      for (; i < end; i++) {
        if (lines[i] !== '' && !lines[i].startsWith('+')) parseError(i);
        added.push(lines[i].slice(1));
      }
      edits.push(fileEdit(null, path, () => joinFile(added, '\n', true)));
    } else if (action === 'Delete File') {
      if (i < end) parseError(i);
      edits.push(fileEdit(path, null, () => ''));
    } else {
      const movePrefix = '*** Move to: ';
      const move = i < end && lines[i].startsWith(movePrefix);
      const target = move ? lines[i++].slice(movePrefix.length).trim() : path;
      const chunks: { anchor: string; body: Body[]; eof: boolean }[] = [];
      while (i < end) {
        let anchor = '';
        if (lines[i].startsWith('@@')) anchor = lines[i++].slice(2).trim();
        else if (chunks.length || !bodyLine(lines[i])) parseError(i);
        const body: Body[] = [];
        for (; i < end; i++) {
          const row = bodyLine(lines[i]);
          if (!row) break;
          body.push(row);
        }
        const eof = i < end && lines[i] === '*** End of File';
        if (eof) i++;
        chunks.push({ anchor, body, eof });
      }
      if (!chunks.length && !move) parseError(header);
      edits.push(fileEdit(path, target, (text) => {
        const file = splitFile(text);
        let cursor = 0;
        for (const { anchor, body, eof } of chunks) {
          if (anchor) {
            const [found] = matches(file.lines, [anchor], strict, cursor).positions;
            if (found === undefined) throw new Fail('no-match', path);
            cursor = found + 1;
          }
          const old = body.filter((row) => row.kind !== '+').map((row) => row.text);
          const match = old.length ? matches(file.lines, old, strict, cursor, eof) : { tier: 0, positions: [eof ? file.lines.length : cursor] };
          const [at] = match.positions;
          if (at === undefined) throw new Fail('no-match', path);
          cursor = at + replace(file.lines, at, old, body, match.tier);
        }
        return joinFile(file.lines, file.br, file.final);
      }, move));
    }
    i = next;
  }
  return edits;
}

type Hunk = { offset: number; body: Body[] };
type Section = {
  paths: [string | null, string | null];
  headers?: [string | null, string | null];
  from?: string;
  to?: string;
  create?: boolean;
  remove?: boolean;
  hunks: Hunk[];
};

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: Section | undefined;
  const pair = (i: number) => lines[i].startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const headerPath = (line: string) => {
    const path = line.slice(4).split('\t', 1)[0].trim();
    return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
  };
  const finish = () => {
    if (!section) return;
    const { paths, headers, from, to, create, remove, hunks } = section;
    const [old, target] = headers ?? [from ?? paths[0], to ?? paths[1]];
    const oldPath = create ? null : old;
    const newPath = remove ? null : target;
    if (oldPath !== null || newPath !== null) {
      edits.push(fileEdit(oldPath, newPath, (text) => {
        if (oldPath === null) {
          const added = hunks.flatMap((hunk) => hunk.body.filter((row) => row.kind === '+'));
          return joinFile(added.map((row) => row.text), '\n', !added.at(-1)?.noBreak);
        }
        const file = splitFile(text);
        let delta = 0;
        for (const { offset, body } of hunks) {
          const old = body.filter((row) => row.kind !== '+').map((row) => row.text);
          let at = Math.max(0, Math.min(file.lines.length, offset + delta));
          let tier = 0;
          if (old.length) {
            const found = matches(file.lines, old, strict);
            if (!found.positions.length) throw new Fail('no-match', oldPath);
            const expected = offset - 1 + delta;
            at = found.positions.reduce((best, pos) => Math.abs(pos - expected) < Math.abs(best - expected) ? pos : best);
            tier = found.tier;
          }
          if (at + old.length === file.lines.length) {
            file.final = !body.findLast((row) => row.kind !== '-')?.noBreak;
          }
          delta += replace(file.lines, at, old, body, tier) - old.length;
        }
        return joinFile(file.lines, file.br, file.final);
      }));
    }
    section = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git')) {
      finish();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!match) parseError(i);
      section = { paths: [match[1], match[2]], hunks: [] };
    } else if (pair(i)) {
      if (section?.headers || section?.hunks.length) finish();
      const paths: [string | null, string | null] = [headerPath(line), headerPath(lines[++i])];
      if (section) section.headers = paths;
      else section = { paths, headers: paths, hunks: [] };
    } else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match || !section) parseError(i);
      const body: Body[] = [];
      let j = i + 1;
      for (; j < lines.length && !lines[j].startsWith('diff --git ') && !pair(j); j++) {
        const content = lines[j];
        if (content.startsWith('\\')) {
          const previous = body.at(-1);
          if (previous && !lines[j - 1].startsWith('\\')) previous.noBreak = true;
          continue;
        }
        const row = bodyLine(content);
        if (!row) break;
        body.push(row);
      }
      let tail = j - 1;
      while (tail > i && lines[tail--] === '') body.pop();
      section.hunks.push({ offset: Number(match[1]), body });
      i = j - 1;
    } else if (section && !section.hunks.length) {
      if (line.startsWith('--- ')) parseError(i + 1);
      if (line.startsWith('rename from ')) section.from = line.slice(12);
      if (line.startsWith('rename to ')) section.to = line.slice(10);
      if (line.startsWith('new file mode')) section.create = true;
      if (line.startsWith('deleted file mode')) section.remove = true;
    }
  }
  finish();
  return edits;
}

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
    else if (kind === 'v4a') edits = v4Edits(lines, strict);
    else edits = searchEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, string>();
  const changes = [...tree.now].filter(([p, now]) => tree.original(p) !== now);
  for (const [p, now] of changes) {
    const was = tree.original(p);
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [old, target] of tree.moves) {
    if (rows.get(old) === `D ${old}` && rows.get(target) === `A ${target}`) {
      rows.delete(old);
      rows.set(target, `R ${old} -> ${target}`);
    }
  }
  if (!check) {
    for (const [p, now] of changes) if (now === null) rmSync(p, { force: true });
    for (const [p, now] of changes) {
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const ordered = [...rows].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([, row]) => row);
  return { code: 0, out: [...ordered, `ok: ${rows.size} ${rows.size === 1 ? 'file' : 'files'}`] };
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
