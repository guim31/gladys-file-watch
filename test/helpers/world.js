// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a temporary watch root and
// /data, and a manual clock, with the integration wired on top through
// registerHandlers. No timer runs: the tests scan with `world.hub.scanNow()`.
//
// The arrival time of a file is the latest of its modification and change
// times, and the change time cannot be set: the clock starts at the real time
// of the test, and the tests move it forward (never a fixed date).
// -----------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { keyOf, pathIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

/** A manual clock, shared by the hub and the tests. */
export function createClock(start = Date.now()) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export const tempDir = (prefix = 'gladys-file-watch-') => mkdtempSync(join(tmpdir(), prefix));

/** Write a file (and its folders) under `root`, optionally with an old mtime. */
export function put(root, relative, content = 'x', mtime) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mtime !== undefined) {
    utimesSync(path, mtime / 1000, mtime / 1000);
  }
  return path;
}

export const remove = (root, relative) =>
  rmSync(join(root, relative), { recursive: true, force: true });

export async function createWorld({
  clock = createClock(),
  root = tempDir(),
  dataDir = tempDir('gladys-file-watch-data-'),
  config = {},
  devices = [],
  connect = true,
  timers = false,
  timings = {},
  fs,
} = {}) {
  const gladys = createFakeGladys({ config: { language: 'en', ...config }, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    root,
    fs,
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, app, hub: app.hub, clock, root, dataDir };
}

/** External ids of the device of a watched path. */
export const idsOf = (world, path) => pathIds(world.gladys, keyOf(path));

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

/** The scene events of one trigger, in order. */
export const eventsOf = (world, key) =>
  world.fake.sceneEvents.filter((event) => event.key === key).map((event) => event.data);
