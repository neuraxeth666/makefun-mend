import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN, runCheck, type Check } from './runner.ts';

const test = (id: string, stdin: string, files: Check['files'], exit: number, stdout: string,
  after = files, argv: string[] = []) => ({ check: { id, stdin, files, argv }, exit, stdout, after });

const create = (path: string, file_text: string) => ({ command: 'create', path, file_text });
const parentFirst = JSON.stringify([create('docs', 'file'), create('docs/note.txt', 'note')]);

const cases = [
  test('overlapping search', 'x\n<<<<<<< SEARCH\na\na\n=======\nb\n>>>>>>> REPLACE\n', { x: 'a\na\na\n' },
    1, 'error: ambiguous x\nfailed: 1 of 1 edits\n'),
  test('exact beats nearer fuzzy', '--- x\n+++ x\n@@ -1 +1 @@\n-a\n+b\n', { x: '  a\na' },
    0, 'M x\nok: 1 file\n', { x: '  a\nb\n' }),
  test('equidistant unified matches', '--- x\n+++ x\n@@ -2 +2 @@\n-a\n+b\n', { x: 'a\nq\na' },
    0, 'M x\nok: 1 file\n', { x: 'b\nq\na' }),
  test('context and indentation with CRLF', '--- x\n+++ x\n@@ -99 +99 @@\n head\n-old\n+  new\n\\ No newline at end of file\n',
    { x: '\thead  \r\n\told\r\n' }, 0, 'M x\nok: 1 file\n', { x: '\thead  \r\n\t  new' }),
  test('search inherits path after fence', 'x\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```\n<<<<<<< SEARCH\nb\n=======\nc\n>>>>>>> REPLACE\n',
    { x: 'a' }, 0, 'M x\nok: 1 file\n', { x: 'c' }),
  test('repeated V4A anchor and EOF', '*** Begin Patch\n*** Update File: x\n@@ anchor\n-a\n+b\n@@ anchor\n-a\n+c\n*** End of File\n*** End Patch\n',
    { x: 'anchor\na\nanchor\na\na' }, 0, 'M x\nok: 1 file\n', { x: 'anchor\nb\nanchor\na\nc' }),
  test('failed section leaves no staged changes', '*** Begin Patch\n*** Update File: x\n-a\n+b\n@@\n-missing\n+value\n*** Update File: x\n-a\n+c\n*** End Patch\n',
    { x: 'a\n' }, 1, 'error: no-match x\nfailed: 1 of 2 edits\n'),
  test('rename counts as one row and respects check', 'diff --git a/x b/z\nrename from x\nrename to z\n',
    { x: 'a' }, 0, 'R x -> z\nok: 1 file\n', { x: 'a' }, ['--check']),
  test('parse precedes file lookup', '--- absent\n+++ absent\n@@ -1 +1 @@\n-a\n+b\n@@ broken\n',
    {}, 2, 'error: parse 6\n'),
  test('staged file blocks descendant and leaves the tree untouched', parentFirst,
    { keep: 'original' }, 1, 'error: exists docs/note.txt\nfailed: 1 of 2 edits\n'),
  test('check reports a staged path conflict without writing', parentFirst,
    {}, 1, 'error: exists docs/note.txt\nfailed: 1 of 2 edits\n', {}, ['--check']),
  test('staged descendant blocks a file at its parent',
    JSON.stringify([create('docs/guide/note.txt', 'note'), create('docs', 'file')]),
    {}, 1, 'error: exists docs\nfailed: 1 of 2 edits\n'),
  test('disk file blocks a descendant and discards an earlier modification',
    JSON.stringify([{ command: 'str_replace', path: 'keep', old_str: 'before', new_str: 'after' },
      create('docs/guide/note.txt', 'note')]),
    { docs: 'file', keep: 'before' }, 1, 'error: exists docs/guide/note.txt\nfailed: 1 of 2 edits\n'),
  test('existing directory blocks a file', JSON.stringify([create('docs', 'file')]),
    { 'docs/note.txt': 'note' }, 1, 'error: exists docs\nfailed: 1 of 1 edits\n'),
  test('V4A rename cannot replace a directory',
    '*** Begin Patch\n*** Update File: source\n*** Move to: docs\n*** End Patch\n',
    { source: 'original', 'docs/note.txt': 'note' }, 1, 'error: exists docs\nfailed: 1 of 1 edits\n'),
  test('V4A deletion frees a file path for a directory',
    '*** Begin Patch\n*** Delete File: docs\n*** Add File: docs/note.txt\n+note\n*** End Patch\n',
    { docs: 'file' }, 0, 'D docs\nA docs/note.txt\nok: 2 files\n', { 'docs/note.txt': 'note\n' }),
  test('unified rename can turn the old file path into a parent directory',
    'diff --git a/docs b/docs/note.txt\nrename from docs\nrename to docs/note.txt\n',
    { docs: 'file' }, 0, 'R docs -> docs/note.txt\nok: 1 file\n', { 'docs/note.txt': 'file' }),
];

for (const { check, exit, stdout, after } of cases) {
  const got = runCheck(check);
  assert.deepEqual(got, { id: check.id, exit, stdout, files: after }, check.id);
  assert.deepEqual(runCheck(check), got, `${check.id} replay`);
}
console.log(`${cases.length}/${cases.length} adversarial checks passed twice`);

function checkWriteRollback() {
  const root = mkdtempSync(join(tmpdir(), 'mend-rollback-'));
  try {
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'docs'), 'original docs\r\n');
    writeFileSync(join(root, 'keep'), 'original keep');
    const patch = [
      '*** Begin Patch', '*** Delete File: docs', '*** Add File: docs/deep/note', '+note',
      '*** Update File: keep', '-original keep', '+replacement',
      '*** Add File: last/file', '+last', '*** End Patch', '',
    ].join('\n');
    const inject = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (target === 'last/file') {
          const earlierWritesLanded = fs.readFileSync('docs/deep/note', 'utf8') === 'note\\n' &&
            fs.readFileSync('keep', 'utf8') === 'replacement';
          throw new Error(earlierWritesLanded ? 'injected failure after earlier writes' : 'unexpected write order');
        }
        return rename(source, target);
      };
      syncBuiltinESMExports();
    `;
    const hook = `data:text/javascript,${encodeURIComponent(inject)}`;
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const got = spawnSync(process.execPath, ['--import', hook, MAIN], { cwd: root, env, input: patch, encoding: 'utf8', timeout: 10_000 });
    assert.ifError(got.error);
    assert.equal(got.status, 1);
    assert.equal(got.stdout, '');
    assert.match(got.stderr, /injected failure after earlier writes/);
    assert.deepEqual(readdirSync(root).sort(), ['docs', 'empty', 'keep']);
    assert.deepEqual(readdirSync(join(root, 'empty')), []);
    assert.equal(readFileSync(join(root, 'docs'), 'utf8'), 'original docs\r\n');
    assert.equal(readFileSync(join(root, 'keep'), 'utf8'), 'original keep');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

checkWriteRollback();
checkWriteRollback();
console.log('1/1 write rollback check passed twice');

const practicePath = process.argv[2];
if (practicePath) {
  const { checks } = JSON.parse(readFileSync(practicePath, 'utf8')) as { checks: (Check & { key: string })[] };
  const snapshot = () => Buffer.from(JSON.stringify(checks.map((check) => runCheck({ ...check, id: check.key }))));
  const first = snapshot();
  const second = snapshot();
  assert.deepEqual(second, first, 'official practice replay');
  console.log(`${checks.length} replay results byte-identical, SHA-256 ${createHash('sha256').update(first).digest('hex')}`);
}
