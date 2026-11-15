// -----------------------------------------------------------------------------
// The watch hub: every watched path scanned on a timer of the container (the
// interval chosen in the configuration), the states of the added devices
// published when they change, the scene events fired on transitions, and the
// views the widget, the scene action and the report read.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to one hour, beyond the fixed list of the core scheduler, and the scene
// events fire for every path, added to Gladys or not.
//
// New files: a path absent from the previous scan, unless its inode belonged
// to a path that disappeared (a rename), and only if it arrived after the
// newest file seen so far (a share remounted with its old files announces
// nothing). After a restart there is no previous scan: the files arrived after
// the newest one remembered in /data are the new ones. A path seen for the
// first time sets its state silently, without any scene event.
// -----------------------------------------------------------------------------

import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { matchesAny } from './glob.js';
import {
  buildPathDevice,
  displayName,
  keyOf,
  parsePathId,
  pathIds,
  pathValues,
} from './devices.js';
import { ProblemLog } from './problems.js';
import { scanPath } from './scanner.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  REPORT_TEXT,
  SENTENCE_TEXT,
  formatSize,
  formatTime,
  labelled,
  pick,
} from './texts.js';
import { normalizeConfig } from './config.js';

const logger = createLogger({ name: 'file-watch-hub' });

export const WIDGET_KEY = 'latest_files';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  NEW_FILE: 'new_file',
  STALE: 'folder_stale',
  SIZE: 'size_above',
});

// The thresholds offered by the scene triggers (manifest options, as strings).
export const STALE_HOURS = [1, 3, 6, 12, 24, 48, 72, 168];
export const SIZE_THRESHOLDS_MB = [100, 1000, 10_000, 50_000, 100_000, 500_000, 1_000_000];
// A size threshold fires again once the size went 5 % below it.
const SIZE_REARM = 0.95;

// Beyond this many new files in one scan of a path (a folder copied at once),
// a single event carries the newest file and the count.
export const MAX_EVENTS_PER_SCAN = 5;

export const HUB_TIMINGS = {
  // An unchanged value is sent again this often: Gladys shows "no recent
  // value" after 48 hours.
  heartbeatMs: 12 * 3600_000,
  // The scene action scans again when the last scan is older.
  freshMs: 15_000,
  // Times of FAT and SMB shares have a 2-second granularity: a file written
  // in the same tick as the newest one is still new.
  arrivalSlackMs: 2000,
};

const MAX_TRANSPORTS_PER_REQUEST = 100;
const MESSAGE_MAX = 200;
export const HOST_BASE = '/var/lib/gladysassistant/external-integrations';

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export class WatchHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {object} [options.fs] file system seam of the scanner
   * @param {boolean} [options.timers] the scanning timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, fs, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.fs = fs;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = normalizeConfig({});
    this.signature = null;
    /** @type {Map<string, object>} watched paths, by path relative to the root */
    this.entries = new Map();
    this.rootOk = null;
    this.scannedAt = 0;
    this.scanning = null;
    this.saved = { paths: {} };
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.timer = null;
    this.stopped = false;
    this.problems = new ProblemLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.saved = {
      paths: saved.paths && typeof saved.paths === 'object' ? saved.paths : {},
    };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const first = this.signature === null;
    const languageChanged = !first && this.config.language !== config.language;
    if (first || this.config.root !== config.root) {
      // Created for the user, who then finds it on the host (owned by uid 1000).
      await mkdir(config.root, { recursive: true }).catch(() => {});
    }
    this.config = config;
    const signature = JSON.stringify([config.includeText, config.excludeText, config.maxDepth]);
    if (!first && signature !== this.signature) {
      // Other patterns: files now counted are not new files. The next scan
      // compares with the newest arrival remembered, as after a restart.
      for (const entry of this.entries.values()) {
        entry.snapshot = null;
      }
    }
    this.signature = signature;
    if (languageChanged) {
      this.discovered = null;
    }
    for (const path of config.rejected) {
      logger.warn(`Ignored path "${path}": it leaves /data/watch`);
    }
    try {
      await this.scanNow({ publish: true });
    } finally {
      this.schedule();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.scanning?.catch(() => {});
    await this.store.flush();
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.timer = setTimeout(async () => {
      try {
        await this.scanNow();
        this.problems.recover('scan', 'Scanning works again');
      } catch (err) {
        this.problems.fail('scan', `Scan failed: ${err.message}`, 'error');
      }
      this.schedule();
    }, this.config.pollIntervalMs);
  }

  // --- Scanning ----------------------------------------------------------------

  /** Scan every path now and publish what changed. Concurrent calls share the scan. */
  async scanNow({ publish = false } = {}) {
    if (!this.scanning) {
      const scanning = this.scanAll().finally(() => {
        if (this.scanning === scanning) {
          this.scanning = null;
        }
      });
      this.scanning = scanning;
    }
    const widgetChanged = await this.scanning;
    await this.afterChanges(widgetChanged, { publish });
  }

  /** Scan again when the last scan is older than `freshMs` (scene action). */
  async refreshIfStale() {
    if (this.now() - this.scannedAt >= this.timings.freshMs) {
      await this.scanNow();
    }
  }

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /**
   * The paths to watch: the ones of the configuration, or else every folder
   * and file at the top of the watch root — plus, then, the paths of devices
   * added to Gladys whose folder disappeared (shown as not accessible rather
   * than forgotten).
   */
  async listPaths() {
    const { root, paths, exclude } = this.config;
    if (paths.length > 0) {
      try {
        await stat(root);
        this.rootOk = true;
      } catch {
        this.rootOk = false;
      }
      return paths;
    }
    const found = [];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      this.rootOk = true;
      for (const entry of entries) {
        if (entry.name.startsWith('.') || matchesAny(exclude, entry.name)) {
          continue;
        }
        let ok = entry.isDirectory() || entry.isFile();
        if (entry.isSymbolicLink()) {
          ok = await stat(join(root, entry.name)).then(
            (stats) => stats.isDirectory() || stats.isFile(),
            () => false,
          );
        }
        if (ok) {
          found.push(entry.name);
        }
      }
    } catch {
      this.rootOk = false;
    }
    for (const [key, state] of Object.entries(this.saved.paths)) {
      if (
        typeof state.path === 'string' &&
        !found.includes(state.path) &&
        this.isCreated(pathIds(this.gladys, key).device)
      ) {
        found.push(state.path);
      }
    }
    return found.sort((a, b) => a.localeCompare(b));
  }

  /** @returns {Promise<boolean>} whether the widget shows something new */
  async scanAll() {
    const paths = await this.listPaths();
    let widgetChanged = false;
    const before = [...this.entries.keys()].join('\n');
    const next = new Map();
    for (const path of paths) {
      next.set(
        path,
        this.entries.get(path) ?? {
          path,
          key: keyOf(path),
          scan: null,
          snapshot: null,
          accessible: null,
        },
      );
    }
    this.entries = next;
    if (before !== paths.join('\n')) {
      widgetChanged = true;
      logger.info(
        paths.length === 0
          ? `Nothing to watch in ${this.config.root}`
          : `Watching ${paths.length} path(s) in ${this.config.root}`,
      );
    }

    let dirty = false;
    for (const entry of this.entries.values()) {
      if (this.stopped) {
        break;
      }
      const changed = await this.scanEntry(entry);
      widgetChanged = changed.widget || widgetChanged;
      dirty = changed.saved || dirty;
    }
    // A path no longer watched is forgotten.
    const keys = new Set([...this.entries.values()].map((entry) => entry.key));
    for (const key of Object.keys(this.saved.paths)) {
      if (!keys.has(key)) {
        delete this.saved.paths[key];
        dirty = true;
      }
    }
    // Written only when something changed: no wear of the SD card at every scan.
    if (dirty) {
      this.store.save(this.saved);
    }
    this.scannedAt = this.now();
    await this.publishStates();
    return widgetChanged;
  }

  async scanEntry(entry) {
    const now = this.now();
    const name = displayName(entry.path);
    const previousState = this.saved.paths[entry.key];
    const previous = entry.snapshot;
    const result = await scanPath(join(this.config.root, entry.path), {
      include: this.config.include,
      exclude: this.config.exclude,
      maxDepth: this.config.maxDepth,
      previous,
      since: previous ? null : (previousState?.watermark ?? null),
      now,
      fs: this.fs,
    });

    if (!result.accessible) {
      const changed = entry.accessible !== false;
      if (changed) {
        logger.info(`${name} is not accessible (${result.code})`);
      }
      entry.accessible = false;
      // Back, it is compared with the newest arrival remembered: a share
      // remounted keeps the old times of its files, a folder created again
      // gives fresh ones to its new files.
      entry.snapshot = null;
      return { widget: changed, saved: false };
    }
    if (entry.accessible === false) {
      logger.info(`${name} is accessible again`);
    }

    const before = entry.scan;
    const widget =
      entry.accessible !== true ||
      !before ||
      before.files !== result.files ||
      before.bytes !== result.bytes ||
      before.latest[0]?.relative !== result.latest[0]?.relative ||
      before.latest[0]?.at !== result.latest[0]?.at;
    entry.accessible = true;

    if (result.truncated) {
      this.problems.fail(
        `truncated:${entry.key}`,
        `${name}: more than ${result.files} files, the scan stops there`,
      );
    } else {
      this.problems.recover(`truncated:${entry.key}`);
    }
    if (result.unreadable > 0) {
      this.problems.fail(
        `unreadable:${entry.key}`,
        `${name}: ${result.unreadable} sub-folder(s) cannot be read`,
      );
    } else {
      this.problems.recover(`unreadable:${entry.key}`, `${name}: every sub-folder readable again`);
    }

    const firstEver = !previousState;
    const state = previousState ?? { path: entry.path, watermark: null, stale: [], size: [] };
    const original = JSON.stringify(state);
    state.path = entry.path;

    // New files.
    let added = result.added;
    let addedCount = result.addedCount;
    if (previous) {
      const present = result.inodes;
      const vanished = new Set();
      for (const [relative, ino] of previous) {
        if (!present.has(relative) && ino !== '0') {
          vanished.add(ino);
        }
      }
      const floor =
        state.watermark === null ? -Infinity : state.watermark - this.timings.arrivalSlackMs;
      const kept = added.filter((file) => !vanished.has(file.ino) && file.at > floor);
      addedCount -= added.length - kept.length;
      added = kept;
    }
    if (!firstEver && added.length > 0) {
      await this.fireNewFiles(entry, added, addedCount);
    }
    if (result.lastAt !== null && (state.watermark === null || result.lastAt > state.watermark)) {
      state.watermark = result.lastAt;
    }

    // Thresholds: a path seen for the first time takes the ones already
    // passed without announcing them.
    const language = this.config.language;
    if (result.lastAt !== null) {
      const hours = (now - result.lastAt) / 3600_000;
      const kept = (state.stale ?? []).filter((h) => hours >= h);
      const due = STALE_HOURS.filter((h) => hours >= h && !kept.includes(h));
      for (const h of firstEver ? [] : due) {
        logger.debug(`${name}: not modified for ${h} h`);
        await this.fire(TRIGGERS.STALE, {
          device: pathIds(this.gladys, entry.key).device,
          folder: name,
          hours: h,
          age_hours: Math.floor(hours),
          last_file: result.latest[0]?.relative ?? '',
          last_change: formatTime(result.lastAt, language),
        });
      }
      state.stale = [...kept, ...due].sort((a, b) => a - b);
    }
    const megabytes = result.bytes / 1e6;
    const keptSize = (state.size ?? []).filter((t) => megabytes >= t * SIZE_REARM);
    const dueSize = SIZE_THRESHOLDS_MB.filter((t) => megabytes >= t && !keptSize.includes(t));
    for (const threshold of firstEver ? [] : dueSize) {
      logger.debug(`${name}: above ${threshold} MB`);
      await this.fire(TRIGGERS.SIZE, {
        device: pathIds(this.gladys, entry.key).device,
        folder: name,
        threshold_mb: threshold,
        size: formatSize(result.bytes, language),
        files: result.files,
      });
    }
    state.size = [...keptSize, ...dueSize].sort((a, b) => a - b);

    this.saved.paths[entry.key] = state;
    entry.snapshot = result.inodes;
    const { inodes: _inodes, added: _added, ...scan } = result;
    entry.scan = scan;
    return { widget, saved: JSON.stringify(state) !== original };
  }

  async fireNewFiles(entry, added, count) {
    const name = displayName(entry.path);
    const language = this.config.language;
    // Oldest first; one event per file, or one for the newest of a batch.
    const files = count > MAX_EVENTS_PER_SCAN ? [added[0]] : [...added].sort((a, b) => a.at - b.at);
    logger.debug(`${name}: ${count} new file(s)`);
    for (const file of files) {
      const base = file.relative.slice(file.relative.lastIndexOf('/') + 1);
      const dot = base.lastIndexOf('.');
      await this.fire(TRIGGERS.NEW_FILE, {
        device: pathIds(this.gladys, entry.key).device,
        folder: name,
        file: file.relative.slice(0, 1000),
        extension: dot > 0 ? base.slice(dot + 1).toLowerCase() : '',
        size: formatSize(file.size, language),
        count: count > MAX_EVENTS_PER_SCAN ? count : 1,
      });
    }
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.problems.recover('events', 'Scene events accepted again');
    } catch (err) {
      this.problems.fail('events', `Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /** Publish the Discovery list when it changed (a folder added, the language…). */
  async publishDevices({ force = false } = {}) {
    const language = this.config.language;
    const devices = [...this.entries.keys()].map((path) =>
      buildPathDevice(this.gladys, path, language),
    );
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: scan, publish the list again. */
  async rediscover() {
    await this.scanNow({ publish: true });
  }

  /** The user added (or updated) a device: its states, its badge, the widget. */
  async onDeviceCreated(device) {
    this.transports.delete(device.external_id);
    await this.publishStates();
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** The states of the added devices; the SDK skips the values Gladys already has. */
  async publishStates() {
    const language = this.config.language;
    const now = this.now();
    const states = [];
    for (const entry of this.entries.values()) {
      if (entry.accessible === null || !this.isCreated(pathIds(this.gladys, entry.key).device)) {
        continue; // Gladys drops the states of a device not added
      }
      for (const { key: _key, ...value } of pathValues(this.gladys, entry, language, now)) {
        states.push(value);
      }
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: local, or unreachable when the path is not. */
  async publishTransports() {
    const entries = [];
    for (const entry of this.entries.values()) {
      const externalId = pathIds(this.gladys, entry.key).device;
      if (entry.accessible === null || !this.isCreated(externalId)) {
        continue;
      }
      const transport = entry.accessible ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.problems.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.problems.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (this.rootOk === false) {
      return { connected: false, message: CONNECTION_TEXT.rootMissing };
    }
    if (this.entries.size === 0) {
      return { connected: false, message: CONNECTION_TEXT.nothing };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.problems.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.problems.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views (widget, scene action, report) ------------------------------------------

  /** The watched path of a device external id, null when it is not one. */
  find(externalId) {
    const key = parsePathId(this.gladys, externalId);
    if (!key) {
      return null;
    }
    return [...this.entries.values()].find((entry) => entry.key === key) ?? null;
  }

  /** The name of a path in Gladys: the one given to the device, or its path. */
  nameOf(entry) {
    const externalId = pathIds(this.gladys, entry.key).device;
    const device = (this.gladys.devices ?? []).find((d) => d.external_id === externalId);
    return device?.name || displayName(entry.path);
  }

  /** The folder of the watch root on the host, when the selector is known. */
  hostFolder() {
    const selector = process.env.GLADYS_INTEGRATION_SELECTOR;
    return selector ? `${HOST_BASE}/${selector}/watch` : null;
  }

  /** The state of one path for a scene, with a ready-made sentence. */
  async folderStatus(externalId) {
    await this.refreshIfStale();
    const language = this.config.language;
    const entry = this.find(externalId);
    if (!entry) {
      throw new Error(pick(ACTION_TEXT.unknownPath, language));
    }
    const words = SENTENCE_TEXT[language] ?? SENTENCE_TEXT.en;
    const name = this.nameOf(entry);
    const scan = entry.accessible ? entry.scan : null;
    const latest = scan?.latest[0] ?? null;
    let sentence;
    if (!scan) {
      sentence = labelled(name, words.missing, language);
    } else {
      const parts = [words.summary(scan.files, formatSize(scan.bytes, language))];
      parts.push(
        latest ? words.latest(latest.relative, formatTime(latest.at, language)) : words.empty,
      );
      sentence = labelled(name, parts.join(', '), language);
    }
    return {
      accessible: Boolean(scan),
      files: scan?.files ?? 0,
      size: scan ? formatSize(scan.bytes, language) : '',
      last_file: latest?.relative ?? '',
      last_file_date: latest ? formatTime(latest.at, language) : '',
      age_hours:
        scan?.lastAt != null ? Math.max(0, Math.floor((this.now() - scan.lastAt) / 3600_000)) : 0,
      sentence: `${sentence}.`,
    };
  }

  /** "Check the watched folders": scan now, one line per language. */
  async report() {
    await this.scanNow({ publish: true });
    const host = this.hostFolder();
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      const hostPart = host ? ` ${labelled(text.host, host, language)}` : '';
      const status = this.connectionStatus();
      let main;
      if (!status.connected) {
        main = pick(status.message, language);
      } else {
        const items = [...this.entries.values()].map((entry) => {
          const detail = !entry.accessible
            ? text.missing
            : `${text.files(entry.scan.files)}${entry.scan.truncated ? `, ${text.truncated}` : ''}`;
          return `${displayName(entry.path)} (${detail})`;
        });
        main = `${labelled(text.watched(items.length), items.join(', '), language)}.`;
      }
      if (this.config.rejected.length > 0) {
        main = `${main} ${labelled(this.config.rejected.join(', '), text.rejected, language)}.`;
      }
      message[language] = `${fit(main, MESSAGE_MAX - hostPart.length)}${hostPart}`;
    }
    return message;
  }
}
