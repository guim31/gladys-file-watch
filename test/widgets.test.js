import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { MAX_ROWS } from '../src/widgets.js';
import { createDevices, createWorld, idsOf, put, tempDir } from './helpers/world.js';

async function world() {
  const root = tempDir();
  const base = Date.now() + 3600_000; // future dates: a known order
  for (let i = 0; i < 12; i += 1) {
    put(root, `photos/2026/IMG_${i}.jpg`, 'x'.repeat(1500), base + i * 60_000);
  }
  put(root, 'scans/doc.pdf', 'pdf', base - 60_000);
  return createWorld({ root, config: { paths: 'photos, scans, gone' } });
}

const content = async (w, settings = {}, language = 'en') => {
  const ack = await w.fake.widgetGet('latest_files', { settings, language });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(validateWidgetContent(ack.data.content), [], 'valid widget content');
  return ack.data.content;
};

test('the latest files, newest first, with totals, a caption and the button', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  const { components } = await content(w);
  assert.ok(components.length <= 8);
  assert.ok(components.filter((c) => c.type === 'text').length <= 2);
  assert.deepEqual(
    components.map((c) => c.type),
    ['value', 'value', 'text', 'card-list', 'button'],
  );
  assert.equal(components[0].value, 13);
  assert.deepEqual([components[1].value, components[1].unit], ['18', 'kB']);
  assert.equal(components[2].text, 'Not accessible: gone');
  const list = components[3].items;
  assert.equal(list.length, MAX_ROWS);
  assert.equal(list[0].title, 'IMG_11.jpg');
  assert.equal(list[0].subtitle, 'photos/2026');
  assert.equal(list[0].badge.text, '1.5 kB');
});

test('chosen folders, the name given in Gladys, optional blocks hidden', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  await createDevices(w);
  const scans = idsOf(w, 'scans').device;
  await w.fake.deviceUpdated({
    ...w.fake.devices.find((device) => device.external_id === scans),
    name: 'Printer',
  });
  const { components } = await content(
    w,
    { folders: [scans], show_totals: false, show_refresh: false },
    'fr',
  );
  assert.deepEqual(
    components.map((c) => c.type),
    ['card-list'],
  );
  assert.equal(components[0].items[0].subtitle, 'Printer');
  assert.equal(components[0].items[0].badge.text, '3 o');
});

test('the Refresh button scans again', async (t) => {
  const w = await world();
  t.after(() => w.app.stop());
  put(w.root, 'scans/new.pdf', 'x', Date.now() + 7200_000);
  const ack = await w.fake.widgetAction('latest_files', 'refresh', {}, { settings: {} });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.en, 'Folders scanned again.');
  assert.equal(w.hub.entries.get('scans').scan.files, 2);
});
