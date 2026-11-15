import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { compilePatterns } from '../src/glob.js';
import { LATEST_COUNT, scanPath } from '../src/scanner.js';
import { put, tempDir } from './helpers/world.js';

const scan = (path, options = {}) =>
  scanPath(path, {
    include: compilePatterns(options.include ?? []),
    exclude: compilePatterns(options.exclude ?? []),
    maxDepth: options.maxDepth ?? 5,
    previous: options.previous ?? null,
    since: options.since ?? null,
    now: Date.now(),
    maxFiles: options.maxFiles,
  });

test('counts the files, their size and the newest ones, never reading them', async () => {
  const root = tempDir();
  const old = Date.now() - 3 * 24 * 3600_000;
  put(root, 'a.txt', '12345', old);
  put(root, 'sub/b.txt', '123', old);
  // The change time is always now: a future modification time makes the newest.
  put(root, 'sub/deeper/c.txt', '1', Date.now() + 60_000);
  const result = await scan(root);
  assert.equal(result.accessible, true);
  assert.equal(result.kind, 'dir');
  assert.equal(result.files, 3);
  assert.equal(result.bytes, 9);
  assert.equal(result.latest[0].relative, 'sub/deeper/c.txt');
  assert.deepEqual([...result.inodes.keys()].sort(), ['a.txt', 'sub/b.txt', 'sub/deeper/c.txt']);
  assert.equal(result.added.length, 0, 'no previous scan and no date: nothing is new');
});

test('depth, exclusions (folders not entered) and inclusions (files only)', async () => {
  const root = tempDir();
  put(root, 'top.pdf');
  put(root, 'top.jpg');
  put(root, 'one/two.pdf');
  put(root, 'one/two/three.pdf');
  put(root, '@eaDir/thumb.pdf');
  assert.equal((await scan(root, { maxDepth: 1 })).files, 2, 'top.pdf and top.jpg');
  assert.equal((await scan(root, { maxDepth: 2, exclude: ['@eaDir'] })).files, 3);
  const pdf = await scan(root, { include: ['*.pdf'], exclude: ['@eaDir'] });
  assert.equal(pdf.files, 3);
  const anchored = await scan(root, { include: ['one/**'] });
  assert.deepEqual([...anchored.inodes.keys()].sort(), ['one/two.pdf', 'one/two/three.pdf']);
});

test('symbolic links are skipped, a linked watched path is followed', async () => {
  const root = tempDir();
  put(root, 'real/file.txt');
  symlinkSync(join(root, 'real'), join(root, 'real/loop'));
  symlinkSync(join(root, 'real/file.txt'), join(root, 'real/alias.txt'));
  assert.equal((await scan(join(root, 'real'))).files, 1);
  symlinkSync(join(root, 'real'), join(root, 'link'));
  assert.equal((await scan(join(root, 'link'))).files, 1);
});

test('a single file, a missing path, an empty folder', async () => {
  const root = tempDir();
  const file = put(root, 'app.log', 'hello');
  const single = await scan(file);
  assert.equal(single.kind, 'file');
  assert.equal(single.files, 1);
  assert.equal(single.latest[0].relative, 'app.log');
  assert.deepEqual(await scan(join(root, 'missing')), { accessible: false, code: 'ENOENT' });
  mkdirSync(join(root, 'empty'));
  const empty = await scan(join(root, 'empty'));
  assert.equal(empty.files, 0);
  assert.equal(empty.lastAt, null);
});

test('new files: against the previous scan, or after a date', async () => {
  const root = tempDir();
  put(root, 'a', 'x', Date.now() - 3600_000);
  const first = await scan(root);
  const since = first.lastAt;
  put(root, 'b', 'x', Date.now() + 60_000);
  const compared = await scan(root, { previous: first.inodes });
  assert.deepEqual(
    compared.added.map((file) => file.relative),
    ['b'],
  );
  const dated = await scan(root, { since });
  assert.deepEqual(
    dated.added.map((file) => file.relative),
    ['b'],
  );
});

test('the newest files are kept sorted, and the scan stops at the limit', async () => {
  const root = tempDir();
  const base = Date.now() + 3600_000;
  for (let i = 0; i < 30; i += 1) {
    put(root, `f${i}`, 'x', base + i * 60_000);
  }
  const result = await scan(root);
  assert.equal(result.latest.length, LATEST_COUNT);
  for (let i = 1; i < result.latest.length; i += 1) {
    assert.ok(result.latest[i - 1].at >= result.latest[i].at);
  }
  const truncated = await scan(root, { maxFiles: 10 });
  assert.equal(truncated.files, 10);
  assert.equal(truncated.truncated, true);
});
