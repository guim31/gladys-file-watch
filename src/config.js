// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// Every watched path lives under the watch root, /data/watch: the supervisor
// of Gladys mounts a single folder in the container (/data), and the manifest
// cannot ask for a folder of the host (see README, "Where to put the files").
// -----------------------------------------------------------------------------

import { compilePatterns } from './glob.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Scan intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['30', '60', '300', '900', '3600'];

export const MAX_PATHS = 50;
export const MIN_DEPTH = 1;
export const MAX_DEPTH = 20;

// Temporary files of downloads, copies and editors, system files of Windows,
// macOS and Synology, Samba recycle bins: not files a user waits for.
export const DEFAULT_EXCLUDE =
  '.*, *.tmp, *.part, *.partial, *.crdownload, ~$*, Thumbs.db, desktop.ini, @eaDir, #recycle';

export const DEFAULT_CONFIG = {
  paths: '',
  include: '',
  exclude: DEFAULT_EXCLUDE,
  max_depth: 5,
  poll_interval: '60',
  language: 'fr',
};

/** The watch root in the container (overridable for the tests). */
export const watchRoot = () => process.env.FILE_WATCH_ROOT || '/data/watch';

/**
 * One path typed by the user, relative to the watch root: a full container
 * path (`/data/watch/backups`) is accepted too. `''` is the root itself.
 * @returns {string|null} null when it leaves the root (`..`)
 */
export function normalizePath(raw, root = '/data/watch') {
  if (typeof raw !== 'string') {
    return null;
  }
  let text = raw.trim().replace(/\\/g, '/');
  const prefix = root.replace(/\/+$/, '');
  if (text === prefix || text.startsWith(`${prefix}/`)) {
    text = text.slice(prefix.length);
  }
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    return null;
  }
  return segments.join('/');
}

/** A comma, semicolon or new-line separated list, trimmed, without blanks. */
export const splitList = (raw) =>
  typeof raw === 'string'
    ? raw
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}, root = watchRoot()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const paths = [];
  const rejected = [];
  for (const item of splitList(source.paths)) {
    const path = normalizePath(item, root);
    if (path === null) {
      rejected.push(item);
    } else if (!paths.includes(path) && paths.length < MAX_PATHS) {
      paths.push(path);
    }
  }
  const depth = Math.trunc(Number(source.max_depth));
  const pollInterval = POLL_INTERVALS.includes(String(source.poll_interval))
    ? String(source.poll_interval)
    : DEFAULT_CONFIG.poll_interval;
  const include = typeof source.include === 'string' ? source.include : DEFAULT_CONFIG.include;
  // An exclusion list emptied on purpose stays empty; a missing one takes the default.
  const exclude = typeof source.exclude === 'string' ? source.exclude : DEFAULT_CONFIG.exclude;
  return {
    root,
    paths,
    rejected,
    includeText: splitList(include).join(', '),
    excludeText: splitList(exclude).join(', '),
    include: compilePatterns(splitList(include)),
    exclude: compilePatterns(splitList(exclude)),
    maxDepth: Number.isFinite(depth)
      ? Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, depth))
      : DEFAULT_CONFIG.max_depth,
    pollIntervalMs: Number(pollInterval) * 1000,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
