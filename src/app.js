// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake Gladys)
// and returns the hub, so index.js stays a few lines and the tests drive the
// very same wiring. (Adapted from guim31/gladys-healthchecks.)
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, watchRoot } from './config.js';
import { WatchHub, WIDGET_KEY } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { Store } from './store.js';
import { INIT_FAILED } from './texts.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'file-watch-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: store, root, fs, timers, timings, now
 */
export function registerHandlers(gladys, options = {}) {
  const root = options.root ?? watchRoot();
  const configOf = (raw) => normalizeConfig(raw, root);
  const hub = new WatchHub({
    gladys,
    store: options.store ?? new Store(),
    fs: options.fs,
    timers: options.timers ?? true,
    timings: options.timings,
    now: options.now,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // request arriving during the first scan is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = configOf(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): send again what Gladys may have lost.
        await hub.resync(config);
        return;
      }
      started = true;
      await hub.start(config);
    } catch (err) {
      logger.error('Initialization failed', err);
      hub.connection = null; // the next status computed by the hub replaces this one
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.rediscover()));

  // The devices are published with should_poll: false (the hub scans on its
  // own timer); this only serves a Gladys that would poll anyway.
  gladys.onPoll(whenReady(() => hub.scanNow()));

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));
  // "Update" in the Discovery tab: same as a creation.
  gladys.onDeviceUpdated(whenReady((device) => hub.onDeviceCreated(device)));
  // A device deleted: the widget names it no more; in automatic mode, a path
  // kept only for its device is dropped at the next scan.
  gladys.onDeviceDeleted(whenReady(() => gladys.requestWidgetRefresh(WIDGET_KEY)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      await hub.reconfigure(configOf(newConfig));
    }),
  );

  gladys.onAction(
    'check_paths',
    whenReady(async () => {
      logger.info('Check of the watched paths requested');
      return hub.report();
    }),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
    gladys.onWidgetAction(
      key,
      whenReady((actionKey, params, context = {}) =>
        widget.action(hub, { actionKey, params, ...context }),
      ),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
