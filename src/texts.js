// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, the "Check the watched folders" report, scene outputs and
// errors, dates and sizes. Four languages, the four of the Gladys interface;
// German says "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

export const LANGUAGE_FALLBACK = 'en';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  rootMissing: {
    en: 'The watch folder /data/watch cannot be read: see the documentation.',
    fr: 'Le dossier de surveillance /data/watch est illisible : voir la documentation.',
    de: 'Der Überwachungsordner /data/watch ist nicht lesbar: siehe Dokumentation.',
    es: 'No se puede leer la carpeta de vigilancia /data/watch: consulte la documentación.',
  },
  nothing: {
    en: 'Nothing to watch yet: put or mount a folder in the watch folder (see the documentation).',
    fr: 'Rien à surveiller : placez ou montez un dossier dans le dossier de surveillance (voir la doc).',
    de: 'Noch nichts zu überwachen: Lege oder hänge einen Ordner im Überwachungsordner ein (siehe Doku).',
    es: 'Nada que vigilar: coloque o monte una carpeta en la carpeta de vigilancia (vea la documentación).',
  },
};

export const ACTION_TEXT = {
  unknownPath: {
    en: 'This device is not a watched path of the integration (any more).',
    fr: "Cet appareil n'est pas (ou plus) un chemin surveillé par l'intégration.",
    de: 'Dieses Gerät ist kein überwachter Pfad der Integration (mehr).',
    es: 'Este dispositivo no es (o ya no es) una ruta vigilada por la integración.',
  },
};

// The "Check the watched folders" report and the scene sentence.
export const REPORT_TEXT = {
  en: {
    watched: (count) => `${count} path(s) watched`,
    files: (count) => `${count} file(s)`,
    missing: 'not accessible',
    truncated: 'truncated',
    host: 'host folder',
    rejected: 'ignored (outside /data/watch)',
  },
  fr: {
    watched: (count) => `${count} chemin(s) surveillé(s)`,
    files: (count) => `${count} fichier(s)`,
    missing: 'inaccessible',
    truncated: 'tronqué',
    host: "dossier sur l'hôte",
    rejected: 'ignoré (hors de /data/watch)',
  },
  de: {
    watched: (count) => `${count} Pfad(e) überwacht`,
    files: (count) => `${count} Datei(en)`,
    missing: 'nicht erreichbar',
    truncated: 'abgeschnitten',
    host: 'Ordner auf dem Host',
    rejected: 'ignoriert (außerhalb von /data/watch)',
  },
  es: {
    watched: (count) => `${count} ruta(s) vigilada(s)`,
    files: (count) => `${count} archivo(s)`,
    missing: 'no accesible',
    truncated: 'truncado',
    host: 'carpeta del host',
    rejected: 'ignorado (fuera de /data/watch)',
  },
};

export const SENTENCE_TEXT = {
  en: {
    summary: (files, size) => `${files} file(s), ${size}`,
    latest: (name, date) => `latest: ${name} (${date})`,
    empty: 'no file',
    missing: 'not accessible',
  },
  fr: {
    summary: (files, size) => `${files} fichier(s), ${size}`,
    latest: (name, date) => `dernier : ${name} (${date})`,
    empty: 'aucun fichier',
    missing: 'inaccessible',
  },
  de: {
    summary: (files, size) => `${files} Datei(en), ${size}`,
    latest: (name, date) => `neueste: ${name} (${date})`,
    empty: 'keine Datei',
    missing: 'nicht erreichbar',
  },
  es: {
    summary: (files, size) => `${files} archivo(s), ${size}`,
    latest: (name, date) => `último: ${name} (${date})`,
    empty: 'ningún archivo',
    missing: 'no accesible',
  },
};

const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

// Decimal units, as file managers and NAS interfaces show them; French says
// "octet".
const SIZE_UNITS = {
  en: ['B', 'kB', 'MB', 'GB', 'TB'],
  fr: ['o', 'ko', 'Mo', 'Go', 'To'],
  de: ['B', 'kB', 'MB', 'GB', 'TB'],
  es: ['B', 'kB', 'MB', 'GB', 'TB'],
};

const formats = new Map();
const cached = (key, build) => {
  if (!formats.has(key)) {
    formats.set(key, build());
  }
  return formats.get(key);
};

/** `1.5 GB`, `1,5 Go`: a size for a sentence or a widget. */
export function formatSize(bytes, language) {
  const units = SIZE_UNITS[language] ?? SIZE_UNITS.en;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const locale = LOCALES[language] ?? LOCALES.en;
  const number = cached(
    `n:${locale}`,
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
  );
  return `${number.format(value)} ${units[unit]}`;
}

/**
 * Day, month, year and time, in the time zone of Gladys (`TZ`, set by the
 * supervisor) and the language of the configuration.
 */
export function formatTime(time, language) {
  const locale = LOCALES[language] ?? LOCALES.en;
  const format = cached(
    `d:${locale}`,
    () =>
      new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
  );
  // en-GB, de-DE and es-ES put a comma between the date and the time.
  return format.format(new Date(time)).replace(', ', ' ');
}

export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
