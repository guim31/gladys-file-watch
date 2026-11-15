// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow): one device per watched path (a folder, or a single file), keyed by
// a hash of its path relative to /data/watch.
//
//   files           counter-sensor/integer   files counted (after the patterns)
//   size            data/size (MB)           their total size
//   last_file       text/text                the latest file arrived, relative path
//   last_file_date  text/text                its date (the language of the configuration)
//   age             duration/integer (min)   time since the latest file arrived
//   accessible      input/binary             1 readable, 0 missing or unreadable
//
// Published with should_poll: false: the integration scans on its own timer
// (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { formatTime } from './texts.js';

export const PATH_TYPE = 'path';
export const MODEL = 'File watch';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  FILES: 'files',
  SIZE: 'size',
  LAST_FILE: 'last_file',
  LAST_FILE_DATE: 'last_file_date',
  AGE: 'age',
  ACCESSIBLE: 'accessible',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.FILES]: 'Files',
    [FEATURE_KEYS.SIZE]: 'Total size',
    [FEATURE_KEYS.LAST_FILE]: 'Latest file',
    [FEATURE_KEYS.LAST_FILE_DATE]: 'Latest file date',
    [FEATURE_KEYS.AGE]: 'Time since last change',
    [FEATURE_KEYS.ACCESSIBLE]: 'Accessible',
  },
  fr: {
    [FEATURE_KEYS.FILES]: 'Fichiers',
    [FEATURE_KEYS.SIZE]: 'Taille totale',
    [FEATURE_KEYS.LAST_FILE]: 'Dernier fichier',
    [FEATURE_KEYS.LAST_FILE_DATE]: 'Date du dernier fichier',
    [FEATURE_KEYS.AGE]: 'Temps depuis la dernière modification',
    [FEATURE_KEYS.ACCESSIBLE]: 'Accessible',
  },
  de: {
    [FEATURE_KEYS.FILES]: 'Dateien',
    [FEATURE_KEYS.SIZE]: 'Gesamtgröße',
    [FEATURE_KEYS.LAST_FILE]: 'Neueste Datei',
    [FEATURE_KEYS.LAST_FILE_DATE]: 'Datum der neuesten Datei',
    [FEATURE_KEYS.AGE]: 'Zeit seit der letzten Änderung',
    [FEATURE_KEYS.ACCESSIBLE]: 'Erreichbar',
  },
  es: {
    [FEATURE_KEYS.FILES]: 'Archivos',
    [FEATURE_KEYS.SIZE]: 'Tamaño total',
    [FEATURE_KEYS.LAST_FILE]: 'Último archivo',
    [FEATURE_KEYS.LAST_FILE_DATE]: 'Fecha del último archivo',
    [FEATURE_KEYS.AGE]: 'Tiempo desde la última modificación',
    [FEATURE_KEYS.ACCESSIBLE]: 'Accesible',
  },
};

// Display bounds (the core never applies them on write).
export const MAX_FILES_SHOWN = 10_000_000;
export const MAX_SIZE_MB = 100_000_000; // 100 TB
export const MAX_AGE_MINUTES = 10 * 365 * 24 * 60;

/** The key of a path: stable, short, free of the characters of the path. */
export const keyOf = (path) => createHash('sha1').update(`path:${path}`).digest('hex').slice(0, 20);

export const pathIds = (gladys, key) => gladys.externalIds(PATH_TYPE, key);

/** The path key of a device external id, null when it is not one of ours. */
export function parsePathId(gladys, externalId) {
  const prefix = pathIds(gladys, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const key = externalId.slice(prefix.length);
  return /^[0-9a-f]{20}$/.test(key) ? key : null;
}

/** The name of a path in Gladys: its path under /data/watch. */
export const displayName = (path) => (path === '' ? 'watch' : path);

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

const text = (name, externalId) =>
  sensor(name, externalId, DEVICE_FEATURE_CATEGORIES.TEXT, DEVICE_FEATURE_TYPES.TEXT.TEXT, {
    keep_history: false,
    min: 0,
    max: 0,
  });

/** The discovery payload of a watched path. */
export function buildPathDevice(gladys, path, language = 'en') {
  const ids = pathIds(gladys, keyOf(path));
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: displayName(path).slice(0, 255),
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [{ name: 'PATH', value: `/data/watch/${path}`.replace(/\/$/, '').slice(0, 255) }],
    features: [
      sensor(
        names[FEATURE_KEYS.FILES],
        ids.feature(FEATURE_KEYS.FILES),
        DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        { keep_history: true, min: 0, max: MAX_FILES_SHOWN },
      ),
      sensor(
        names[FEATURE_KEYS.SIZE],
        ids.feature(FEATURE_KEYS.SIZE),
        DEVICE_FEATURE_CATEGORIES.DATA,
        DEVICE_FEATURE_TYPES.DATA.SIZE,
        { unit: DEVICE_FEATURE_UNITS.MEGABYTE, keep_history: true, min: 0, max: MAX_SIZE_MB },
      ),
      text(names[FEATURE_KEYS.LAST_FILE], ids.feature(FEATURE_KEYS.LAST_FILE)),
      text(names[FEATURE_KEYS.LAST_FILE_DATE], ids.feature(FEATURE_KEYS.LAST_FILE_DATE)),
      sensor(
        names[FEATURE_KEYS.AGE],
        ids.feature(FEATURE_KEYS.AGE),
        DEVICE_FEATURE_CATEGORIES.DURATION,
        DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        { unit: DEVICE_FEATURE_UNITS.MINUTES, keep_history: true, min: 0, max: MAX_AGE_MINUTES },
      ),
      sensor(
        names[FEATURE_KEYS.ACCESSIBLE],
        ids.feature(FEATURE_KEYS.ACCESSIBLE),
        DEVICE_FEATURE_CATEGORIES.INPUT,
        DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        { keep_history: true, min: 0, max: 1 },
      ),
    ],
  };
}

export const toMegabytes = (bytes) => Math.round(bytes / 10_000) / 100;
export const ageMinutes = (lastAt, now) =>
  Math.min(MAX_AGE_MINUTES, Math.max(0, Math.floor((now - lastAt) / 60_000)));

/**
 * The value of every feature of a path: `{ key, device_feature_external_id,
 * state|text }`. An inaccessible path only says so (the last values stay).
 */
export function pathValues(gladys, entry, language, now) {
  const ids = pathIds(gladys, entry.key);
  const scan = entry.scan;
  const values = [{ key: FEATURE_KEYS.ACCESSIBLE, state: entry.accessible ? 1 : 0 }];
  if (entry.accessible && scan) {
    const latest = scan.latest[0];
    values.push(
      { key: FEATURE_KEYS.FILES, state: scan.files },
      { key: FEATURE_KEYS.SIZE, state: toMegabytes(scan.bytes) },
      { key: FEATURE_KEYS.LAST_FILE, text: latest ? latest.relative.slice(0, 255) : '-' },
      { key: FEATURE_KEYS.LAST_FILE_DATE, text: latest ? formatTime(latest.at, language) : '-' },
    );
    if (scan.lastAt !== null) {
      values.push({ key: FEATURE_KEYS.AGE, state: ageMinutes(scan.lastAt, now) });
    }
  }
  return values.map(({ key, ...value }) => ({
    key,
    device_feature_external_id: ids.feature(key),
    ...value,
  }));
}
