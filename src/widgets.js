// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `latest_files`.
//
// The use case: the scans of the printer, the photos of the phone, the
// recordings of a camera, the nightly backup — a glance tells what arrived
// last, where and when. So the widget lists the latest files of the chosen
// folders (all by default), newest first, with their folder and size, above
// two optional tiles (files, total size) and an optional Refresh button.
//
// Budget (8 components, 2 texts): two tiles, one caption naming the folders
// not accessible, one card list of 8 rows at most, a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from './hub.js';
import { CONNECTION_TEXT, formatSize, labelled, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 8;

export const TEXT = {
  empty: {
    en: 'No file in the watched folders yet.',
    fr: 'Aucun fichier dans les dossiers surveillés pour le moment.',
    de: 'Noch keine Datei in den überwachten Ordnern.',
    es: 'Todavía no hay ningún archivo en las carpetas vigiladas.',
  },
  files: { en: 'Files', fr: 'Fichiers', de: 'Dateien', es: 'Archivos' },
  size: { en: 'Total size', fr: 'Taille totale', de: 'Gesamtgröße', es: 'Tamaño total' },
  missing: {
    en: 'Not accessible',
    fr: 'Inaccessible',
    de: 'Nicht erreichbar',
    es: 'No accesible',
  },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Folders scanned again.',
    fr: 'Dossiers analysés à nouveau.',
    de: 'Ordner neu durchsucht.',
    es: 'Carpetas analizadas de nuevo.',
  },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: pick(text, language) }],
  };
}

/** The watched paths the widget shows: the chosen devices, or every path. */
export function selectEntries(hub, settings) {
  const chosen = [settings?.folders ?? []].flat().filter((id) => typeof id === 'string' && id);
  if (chosen.length === 0) {
    return [...hub.entries.values()];
  }
  return [...new Set(chosen)].map((id) => hub.find(id)).filter(Boolean);
}

async function get(hub, { settings = {}, language = 'en' }) {
  const status = hub.connectionStatus();
  if (!status.connected) {
    return message(status.message ?? CONNECTION_TEXT.nothing, language);
  }
  const entries = selectEntries(hub, settings);
  const readable = entries.filter((entry) => entry.accessible && entry.scan);
  const missing = entries.filter((entry) => entry.accessible === false);
  const components = [];

  if (settings.show_totals !== false) {
    const files = readable.reduce((sum, entry) => sum + entry.scan.files, 0);
    const bytes = readable.reduce((sum, entry) => sum + entry.scan.bytes, 0);
    const [amount, unit] = formatSize(bytes, language).split(' ');
    components.push(
      {
        type: 'value',
        value: files,
        label: pick(TEXT.files, language),
        icon: 'file',
        color: WIDGET_COLORS.PRIMARY,
      },
      {
        type: 'value',
        value: amount,
        unit,
        label: pick(TEXT.size, language),
        icon: 'hard-drive',
        color: WIDGET_COLORS.NEUTRAL,
      },
    );
  }

  if (missing.length > 0) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: fit(
        labelled(
          pick(TEXT.missing, language),
          missing.map((entry) => hub.nameOf(entry)).join(', '),
          language,
        ),
        80,
      ),
    });
  }

  const files = readable
    .flatMap((entry) => entry.scan.latest.map((file) => ({ ...file, entry })))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROWS);
  if (files.length > 0) {
    components.push({
      type: 'card-list',
      display: 'list',
      items: files.map((file) => {
        const slash = file.relative.lastIndexOf('/');
        const folder =
          slash === -1
            ? hub.nameOf(file.entry)
            : `${hub.nameOf(file.entry)}/${file.relative.slice(0, slash)}`;
        return {
          title: fit(file.relative.slice(slash + 1), 60),
          subtitle: fit(folder, 60),
          date: new Date(file.at).toISOString(),
          badge: { text: fit(formatSize(file.size, language), 16), color: WIDGET_COLORS.NEUTRAL },
        };
      }),
    });
  } else if (missing.length === 0) {
    components.push({ type: 'text', variant: 'body', text: pick(TEXT.empty, language) });
  }

  if (settings.show_refresh !== false) {
    components.push({
      type: 'button',
      label: pick(TEXT.refresh, language),
      icon: 'refresh-cw',
      style: 'secondary',
      action: { key: ACTIONS.REFRESH },
    });
  }

  return { ttl_seconds: Math.max(30, Math.round(hub.config.pollIntervalMs / 1000)), components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.scanNow();
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
