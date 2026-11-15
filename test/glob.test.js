import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePatterns, globToRegExp, matchesAny } from '../src/glob.js';
import { DEFAULT_EXCLUDE, normalizeConfig, normalizePath, splitList } from '../src/config.js';

const match = (patterns, path) => matchesAny(compilePatterns(patterns), path);

test('a pattern without a slash matches the name at any depth', () => {
  assert.ok(match(['*.pdf'], 'scan.pdf'));
  assert.ok(match(['*.pdf'], '2026/11/scan.PDF'), 'case-insensitive');
  assert.ok(!match(['*.pdf'], 'scan.pdf.part'));
  assert.ok(match(['@eaDir'], 'photos/@eaDir'));
  assert.ok(match(['.*'], 'a/.hidden'));
  assert.ok(!match(['.*'], 'a/visible.txt'));
});

test('a pattern with a slash matches the relative path, ** crosses folders', () => {
  assert.ok(match(['daily/*.tar.gz'], 'daily/backup.tar.gz'));
  assert.ok(!match(['daily/*.tar.gz'], 'old/daily/backup.tar.gz'));
  assert.ok(!match(['daily/*.tar.gz'], 'daily/sub/backup.tar.gz'));
  assert.ok(match(['**/cache/**'], 'a/b/cache/x/y.bin'));
  assert.ok(match(['**/cache/**'], 'cache/y.bin'));
  assert.ok(match(['/daily/'], 'daily'), 'leading and trailing slashes');
});

test('?, character classes and literal characters', () => {
  assert.ok(match(['img_????.jpg'], 'IMG_0001.JPG'));
  assert.ok(match(['[ab]*.log'], 'b-1.log'));
  assert.ok(!match(['[!ab]*.log'], 'a-1.log'));
  assert.ok(match(['[!ab]*.log'], 'c-1.log'));
  assert.ok(match(['report (1).txt'], 'report (1).txt'));
  assert.ok(match(['#recycle'], '#recycle'));
  assert.ok(match(['~$*'], '~$doc.docx'));
  assert.ok(globToRegExp('a+b[').test('a+b['), 'an unclosed class is literal');
  assert.equal(compilePatterns(['', ' ', '/']).length, 0);
});

test('the default exclusions skip temporary and system files only', () => {
  const exclude = compilePatterns(splitList(DEFAULT_EXCLUDE));
  for (const path of [
    '.DS_Store',
    'a/.stfolder',
    'x.tmp',
    'movie.mkv.part',
    'Thumbs.db',
    'p/@eaDir',
  ]) {
    assert.ok(matchesAny(exclude, path), path);
  }
  for (const path of ['backup.tar.gz', 'scan 2026.pdf', 'photos/IMG_1.jpg']) {
    assert.ok(!matchesAny(exclude, path), path);
  }
});

test('paths stay under the watch root', () => {
  assert.equal(normalizePath(' backups/ '), 'backups');
  assert.equal(normalizePath('/data/watch/nas/scans'), 'nas/scans');
  assert.equal(normalizePath('/nas//scans/.'), 'nas/scans');
  assert.equal(normalizePath('nas\\scans'), 'nas/scans');
  assert.equal(normalizePath('/data/watch'), '');
  assert.equal(normalizePath('.'), '');
  assert.equal(normalizePath('../etc'), null);
  assert.equal(normalizePath('a/../../b'), null);
  const config = normalizeConfig({ paths: 'a, b;a\n../x, /data/watch/c' }, '/data/watch');
  assert.deepEqual(config.paths, ['a', 'b', 'c']);
  assert.deepEqual(config.rejected, ['../x']);
});

test('the configuration falls back to its defaults', () => {
  const config = normalizeConfig({ max_depth: 'x', poll_interval: '7', language: 'it' });
  assert.equal(config.maxDepth, 5);
  assert.equal(config.pollIntervalMs, 60_000);
  assert.equal(config.language, 'fr');
  assert.ok(config.exclude.length > 0);
  assert.equal(normalizeConfig({ exclude: '' }).exclude.length, 0, 'an emptied list stays empty');
  assert.equal(normalizeConfig({ max_depth: 99 }).maxDepth, 20);
  assert.equal(normalizeConfig({ max_depth: 0 }).maxDepth, 1);
});
