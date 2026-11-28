import test from 'node:test';
import assert from 'node:assert/strict';
import { kvvCancel, cancelsForMap } from '../api/_kvv.mjs';

test('KVV-Ausfälle: ganze Fahrt nur bei mehreren Stationen ohne normale Meldung', () => {
  const now = Date.now();
  kvvCancel.clear();
  kvvCancel.set('ganz', { c: new Set([1, 2]), s: new Set(), at: now });
  kvvCancel.set('teil', { c: new Set([3]), s: new Set([4]), at: now });
  kvvCancel.set('einzeln', { c: new Set([5]), s: new Set(), at: now });
  kvvCancel.set('normal', { c: new Set(), s: new Set([6]), at: now });
  kvvCancel.set('alt', { c: new Set([7, 8]), s: new Set(), at: now - 40 * 60000 });
  assert.deepEqual(cancelsForMap(), { kc: ['ganz'], kx: { teil: [3], einzeln: [5] } });
  assert.equal(kvvCancel.has('alt'), false);
});
