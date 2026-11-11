import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Model } from '../server/model.mjs';

const file = new URL('../data/model.json', import.meta.url);
test('planMany liefert mehrere Abfahrten statt nur der nächsten', { skip: !fs.existsSync(file) }, () => {
  const m = new Model(JSON.parse(fs.readFileSync(file, 'utf8')));
  const id = (n) => m.stops.findIndex((s) => s[1] === n);
  const a = id('KA Marktplatz (Pyramide U)');
  const b = id('Karlsruhe Europaplatz');
  if (a < 0 || b < 0) return;
  const ymd = m.meta.feedStart || '20261112';
  const r = m.planMany(a, b, ymd, 8 * 3600, {}, 5);
  if (!r.length) return; // Fahrplan ohne Verkehr an diesem Tag
  assert.ok(r.length > 1, 'mehr als eine Verbindung');
  for (let i = 1; i < r.length; i++) assert.ok(r[i].start >= r[i - 1].start, 'nach Abfahrt sortiert');
});
