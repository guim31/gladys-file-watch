// -----------------------------------------------------------------------------
// The watch hub on a real temporary folder: discovery, states, the three
// scene triggers and their edge cases (rename, batch, restart, a folder
// deleted then created again, other patterns), the quiet logs and the timer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@gladysassistant/integration-sdk';
import { FEATURE_KEYS } from '../src/devices.js';
import { MAX_EVENTS_PER_SCAN, STALE_HOURS, TRIGGERS } from '../src/hub.js';
import {
  createClock,
  createDevices,
  createWorld,
  eventsOf,
  idsOf,
  put,
  remove,
  tempDir,
} from './helpers/world.js';

const HOUR = 3600_000;

function folderRoot() {
  const root = tempDir();
  put(root, 'backups/monday.tar.gz', 'x'.repeat(2000));
  put(root, 'scans/doc.pdf', 'pdf');
  put(root, 'app.log', 'line');
  mkdirSync(join(root, '.hidden'));
  return root;
}

test('every top-level folder and file is proposed, hidden ones aside', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['app.log', 'backups', 'scans'],
  );
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.ok(world.fake.discoveredDevices.every((device) => device.should_poll === false));
});

test('the configured paths only, a path leaving the root ignored', async (t) => {
  const world = await createWorld({
    root: folderRoot(),
    config: { paths: 'scans, ../etc, missing' },
  });
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['scans', 'missing'],
  );
  await createDevices(world);
  assert.equal(world.fake.lastState(idsOf(world, 'missing').feature(FEATURE_KEYS.ACCESSIBLE)), 0);
  assert.deepEqual(
    world.fake.transports.find(
      (entry) => entry.device_external_id === idsOf(world, 'missing').device,
    )?.transport,
    'unreachable',
  );
  const report = await world.fake.action('check_paths', {});
  assert.match(
    report.data.message.en,
    /2 path\(s\) watched: scans \(1 file\(s\)\), missing \(not accessible\)/,
  );
  assert.match(report.data.message.en, /\.\.\/etc: ignored/);
});

test('nothing to watch: the status says where to put the folders', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /Nothing to watch/);
  assert.deepEqual(Object.keys(world.fake.connectionStatus.message), ['en', 'fr', 'de', 'es']);
  const widget = await world.fake.widgetGet('latest_files', { settings: {}, language: 'fr' });
  assert.match(widget.data.content.components[0].text, /Rien à surveiller/);
});

test('states are published for the added devices only, all again on creation', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  assert.equal(world.fake.states.length, 0, 'no device added yet');
  await createDevices(world, (device) => device.name === 'backups');
  const ids = idsOf(world, 'backups');
  const state = (key) => world.fake.lastState(ids.feature(key));
  assert.equal(state(FEATURE_KEYS.FILES), 1);
  assert.equal(state(FEATURE_KEYS.SIZE), 0);
  assert.equal(state(FEATURE_KEYS.LAST_FILE), 'monday.tar.gz');
  assert.match(state(FEATURE_KEYS.LAST_FILE_DATE), /^\d\d\/\d\d\/\d\d \d\d:\d\d$/);
  assert.equal(state(FEATURE_KEYS.AGE), 0);
  assert.equal(state(FEATURE_KEYS.ACCESSIBLE), 1);
  assert.ok(
    world.fake.states.every((s) => s.device_feature_external_id.startsWith(ids.device)),
    'nothing for the paths not added',
  );

  const count = world.fake.states.length;
  await world.hub.scanNow();
  assert.equal(world.fake.states.length, count, 'nothing changed, nothing sent');
  world.clock.advance(2 * HOUR + 30_000); // Date.now() is in ms, the file times in ns
  await world.hub.scanNow();
  assert.equal(state(FEATURE_KEYS.AGE), 120);
  assert.equal(world.fake.states.length, count + 1, 'only the age moved');
});

test('a new file fires one event; a rename and a deletion fire none', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  assert.equal(world.fake.sceneEvents.length, 0, 'the first scan only sets the state');

  put(world.root, 'scans/2026/invoice.PDF', '12345');
  await world.hub.scanNow();
  assert.deepEqual(eventsOf(world, TRIGGERS.NEW_FILE), [
    {
      device: idsOf(world, 'scans').device,
      folder: 'scans',
      file: '2026/invoice.PDF',
      extension: 'pdf',
      size: '5 B',
      count: 1,
    },
  ]);

  renameSync(join(world.root, 'scans/doc.pdf'), join(world.root, 'scans/renamed.pdf'));
  remove(world.root, 'scans/2026/invoice.PDF');
  await world.hub.scanNow();
  assert.equal(eventsOf(world, TRIGGERS.NEW_FILE).length, 1);
});

test('a batch of files fires one event with the count', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  for (let i = 0; i < MAX_EVENTS_PER_SCAN + 3; i += 1) {
    put(world.root, `backups/part-${i}.bin`);
  }
  await world.hub.scanNow();
  const events = eventsOf(world, TRIGGERS.NEW_FILE);
  assert.equal(events.length, 1);
  assert.equal(events[0].count, MAX_EVENTS_PER_SCAN + 3);
  assert.match(events[0].file, /^part-\d\.bin$/);
});

test('the files arrived while the integration was stopped are announced once', async (t) => {
  const root = folderRoot();
  const dataDir = tempDir('gladys-file-watch-data-');
  const first = await createWorld({ root, dataDir });
  await first.app.stop();
  put(root, 'backups/tuesday.tar.gz');
  const second = await createWorld({ root, dataDir });
  t.after(() => second.app.stop());
  assert.deepEqual(
    eventsOf(second, TRIGGERS.NEW_FILE).map((event) => event.file),
    ['tuesday.tar.gz'],
  );
  await second.hub.scanNow();
  assert.equal(eventsOf(second, TRIGGERS.NEW_FILE).length, 1);
});

test('a folder deleted then created again: not accessible, then its new files', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  await createDevices(world);
  const accessible = idsOf(world, 'backups').feature(FEATURE_KEYS.ACCESSIBLE);
  remove(world.root, 'backups');
  await world.hub.scanNow();
  assert.equal(world.fake.lastState(accessible), 0, 'kept while its device exists');
  put(world.root, 'backups/monday.tar.gz');
  put(world.root, 'backups/wednesday.tar.gz');
  await world.hub.scanNow();
  assert.equal(world.fake.lastState(accessible), 1);
  assert.deepEqual(
    eventsOf(world, TRIGGERS.NEW_FILE).map((event) => event.file),
    ['monday.tar.gz', 'wednesday.tar.gz'],
  );
});

test('a share remounted with its old files announces nothing', async (t) => {
  const root = tempDir();
  const old = Date.now() - 48 * HOUR;
  put(root, 'share/a.jpg', 'x', old);
  const world = await createWorld({ root });
  t.after(() => world.app.stop());
  // The files keep their old dates; the change time is now: only the
  // modification date can be old in a test, so compare at the same instant.
  remove(root, 'share/a.jpg');
  await world.hub.scanNow();
  assert.equal(world.hub.entries.get('share').scan.files, 0);
  assert.equal(eventsOf(world, TRIGGERS.NEW_FILE).length, 0);
});

test('other patterns: the files now counted are not new files', async (t) => {
  const world = await createWorld({ root: folderRoot(), config: { include: '*.gz' } });
  t.after(() => world.app.stop());
  assert.equal(world.hub.entries.get('scans').scan.files, 0);
  await world.fake.configUpdated({ language: 'en', include: '' });
  assert.equal(world.hub.entries.get('scans').scan.files, 1);
  assert.equal(eventsOf(world, TRIGGERS.NEW_FILE).length, 0);
});

test('the exclusions hide files and folders from counts and events', async (t) => {
  const world = await createWorld({ root: folderRoot(), config: { exclude: '*.tmp, cache' } });
  t.after(() => world.app.stop());
  put(world.root, 'scans/upload.tmp');
  put(world.root, 'scans/cache/thumb.jpg');
  await world.hub.scanNow();
  assert.equal(world.hub.entries.get('scans').scan.files, 1);
  assert.equal(eventsOf(world, TRIGGERS.NEW_FILE).length, 0);
});

test('stale folder: each threshold fires once, and again after a new file', async (t) => {
  const root = folderRoot();
  const clock = createClock();
  const world = await createWorld({ root, clock });
  t.after(() => world.app.stop());
  clock.advance(25 * HOUR + 30_000);
  await world.hub.scanNow();
  const stale = eventsOf(world, TRIGGERS.STALE).filter((e) => e.folder === 'backups');
  assert.deepEqual(
    stale.map((event) => event.hours),
    [Math.max(...STALE_HOURS.filter((h) => h <= 25))],
    'several thresholds at once: the highest only',
  );
  assert.equal(stale[0].age_hours, 25);
  assert.equal(stale[0].last_file, 'monday.tar.gz');
  assert.equal(typeof stale[0].last_change, 'string');
  await world.hub.scanNow();
  assert.equal(eventsOf(world, TRIGGERS.STALE).filter((e) => e.folder === 'backups').length, 1);

  // A new backup: the age falls back to 0, an hour later the 1 h threshold fires again.
  put(world.root, 'backups/tuesday.tar.gz', 'x', clock.now());
  await world.hub.scanNow();
  clock.advance(HOUR + 60_000);
  await world.hub.scanNow();
  const again = eventsOf(world, TRIGGERS.STALE).filter((e) => e.folder === 'backups');
  assert.deepEqual(
    again.slice(1).map((event) => event.hours),
    [1],
  );
});

test('a stale folder at install fires nothing', async (t) => {
  const root = tempDir();
  put(root, 'old/file', 'x');
  const clock = createClock(Date.now() + 100 * HOUR);
  const world = await createWorld({ root, clock });
  t.after(() => world.app.stop());
  await world.hub.scanNow();
  assert.equal(eventsOf(world, TRIGGERS.STALE).length, 0);
});

test('size above a threshold: fires once, again after going 5 % below', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  const big = put(world.root, 'backups/big.img', '');
  truncateSync(big, 150e6); // sparse: 150 MB announced, nothing written
  await world.hub.scanNow();
  const size = () => eventsOf(world, TRIGGERS.SIZE);
  assert.deepEqual(size(), [
    {
      device: idsOf(world, 'backups').device,
      folder: 'backups',
      threshold_mb: 100,
      size: '150 MB',
      files: 2,
    },
  ]);
  truncateSync(big, 97e6);
  await world.hub.scanNow();
  assert.equal(size().length, 1, 'between 95 and 100 MB: not rearmed');
  truncateSync(big, 50e6);
  await world.hub.scanNow();
  truncateSync(big, 120e6);
  await world.hub.scanNow();
  assert.equal(size().length, 2);
});

test('the scene action reads a folder, in the language of the configuration', async (t) => {
  const world = await createWorld({ root: folderRoot(), config: { language: 'fr' } });
  t.after(() => world.app.stop());
  const ack = await world.fake.sceneAction('get_folder_status', {
    device: idsOf(world, 'backups').device,
  });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.outputs.files, 1);
  assert.equal(ack.data.outputs.size, '2 ko');
  assert.match(
    ack.data.outputs.sentence,
    /^backups : 1 fichier\(s\), 2 ko, dernier : monday\.tar\.gz \(/,
  );
  const unknown = await world.fake.sceneAction('get_folder_status', { device: 'nope' });
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /pas \(ou plus\)/);
});

test('a normal scan cycle writes nothing at the info level', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  await createDevices(world);
  const lines = [];
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(logger, level, (...args) => lines.push([level, ...args]));
  }
  put(world.root, 'scans/new.pdf');
  world.clock.advance(60_000);
  await world.hub.scanNow();
  await world.hub.scanNow();
  assert.deepEqual(lines, []);
});

test('the container scans on its own timer, without onPoll', async (t) => {
  const world = await createWorld({
    root: folderRoot(),
    timers: true,
    config: { poll_interval: '30' },
  });
  t.after(() => world.app.stop());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  world.hub.schedule();
  put(world.root, 'scans/timer.pdf');
  t.mock.timers.tick(30_000);
  await world.hub.scanning;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    eventsOf(world, TRIGGERS.NEW_FILE).map((event) => event.file),
    ['timer.pdf'],
  );
});

test('a file reusing the inode of a deleted one is still new (rotation)', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  for (let i = 0; i < 5; i += 1) {
    remove(world.root, i === 0 ? 'backups/monday.tar.gz' : `backups/day-${i - 1}.tar.gz`);
    put(world.root, `backups/day-${i}.tar.gz`, 'y'.repeat(10 + i));
    await world.hub.scanNow();
  }
  assert.deepEqual(
    eventsOf(world, TRIGGERS.NEW_FILE).map((event) => event.file),
    ['day-0.tar.gz', 'day-1.tar.gz', 'day-2.tar.gz', 'day-3.tar.gz', 'day-4.tar.gz'],
  );
});

test('a file dated hours ahead does not hide the next arrivals', async (t) => {
  const world = await createWorld({ root: folderRoot() });
  t.after(() => world.app.stop());
  put(world.root, 'scans/camera.jpg', 'x', Date.now() + 10 * HOUR);
  await world.hub.scanNow();
  put(world.root, 'scans/next.jpg');
  await world.hub.scanNow();
  assert.deepEqual(
    eventsOf(world, TRIGGERS.NEW_FILE).map((event) => event.file),
    ['camera.jpg', 'next.jpg'],
  );
});

test('deleting the newest file does not make the folder stale', async (t) => {
  const root = tempDir();
  put(root, 'logs/old.log', 'x', Date.now() - 30 * HOUR);
  put(root, 'logs/recent.log', 'x');
  const clock = createClock();
  const world = await createWorld({ root, clock });
  t.after(() => world.app.stop());
  remove(root, 'logs/recent.log');
  clock.advance(10 * 60_000);
  await world.hub.scanNow();
  assert.equal(eventsOf(world, TRIGGERS.STALE).length, 0);
});

test('a path empty at first sight announces the files arrived during a restart', async (t) => {
  const root = tempDir();
  mkdirSync(join(root, 'inbox'));
  const dataDir = tempDir('gladys-file-watch-data-');
  const first = await createWorld({ root, dataDir });
  await first.app.stop();
  put(root, 'inbox/letter.pdf');
  const second = await createWorld({ root, dataDir });
  t.after(() => second.app.stop());
  assert.deepEqual(
    eventsOf(second, TRIGGERS.NEW_FILE).map((event) => event.file),
    ['letter.pdf'],
  );
});

test('an invalid pattern is taken literally instead of failing the start', async (t) => {
  const world = await createWorld({ root: folderRoot(), config: { exclude: '[z-a]*, *.log' } });
  t.after(() => world.app.stop());
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['backups', 'scans'],
  );
});
