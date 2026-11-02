import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, nearestNode, shortestPath, simplify, matchSegment, distance } from '../scripts/lib/rail.mjs';

// Gleisnetz: gerade Strecke A-B-C entlang der Breite plus ein Umweg D ueber Nordpunkt
const lat = 49.0;
const ways = [
  [[lat, 8.400], [lat, 8.401], [lat, 8.402], [lat, 8.403]],
  [[lat, 8.401], [lat + 0.001, 8.401], [lat + 0.001, 8.402], [lat, 8.402]], // Schleife
  [[lat + 0.05, 8.5], [lat + 0.05, 8.501]], // abgetrenntes Stueck
];
const graph = buildGraph(ways);

test('Gemeinsame Koordinaten verbinden Wege', () => {
  const a = nearestNode(graph, lat, 8.400, 50);
  const d = nearestNode(graph, lat, 8.403, 50);
  const path = shortestPath(graph, a, d);
  assert.ok(path && path.length >= 4);
});

test('Kuerzester Weg nimmt die gerade Strecke, nicht die Schleife', () => {
  const a = nearestNode(graph, lat, 8.401, 50);
  const b = nearestNode(graph, lat, 8.402, 50);
  const path = shortestPath(graph, a, b);
  assert.equal(path.length, 2);
});

test('Kein Weg zum abgetrennten Stueck', () => {
  const a = nearestNode(graph, lat, 8.400, 50);
  const far = nearestNode(graph, lat + 0.05, 8.5, 50);
  assert.equal(shortestPath(graph, a, far), null);
});

test('Nur Knoten innerhalb der Fangdistanz', () => {
  assert.equal(nearestNode(graph, lat + 0.02, 8.45, 150), -1);
});

test('matchSegment liefert Geometrie mit Start und Ende an den Haltepunkten', () => {
  const a = [lat + 0.00002, 8.4001];
  const b = [lat - 0.00002, 8.4029];
  const pts = matchSegment(graph, a, b);
  assert.ok(pts);
  assert.deepEqual(pts[0], a);
  assert.deepEqual(pts[pts.length - 1], b);
  assert.ok(distance(pts[0], pts[pts.length - 1]) > 150);
});

test('matchSegment gibt null zurueck, wenn der Umweg zu gross waere', () => {
  assert.equal(matchSegment(graph, [lat, 8.400], [lat + 0.05, 8.5]), null);
});

test('simplify entfernt Punkte auf einer Geraden', () => {
  const line = [[lat, 8.4], [lat, 8.4005], [lat, 8.401], [lat, 8.4015]];
  assert.equal(simplify(line, 2).length, 2);
});

import { waysByRef } from '../scripts/lib/rail.mjs';

test('waysByRef sammelt Wege je Liniennummer und ignoriert Unbrauchbares', () => {
  const el = [
    { type: 'relation', tags: { ref: '30' }, members: [
      { type: 'way', geometry: [{ lat: 49, lon: 8.4 }, { lat: 49, lon: 8.41 }] },
      { type: 'node', lat: 49, lon: 8.4 },
      { type: 'way', geometry: [{ lat: 49, lon: 8.41 }] }, // zu kurz
    ] },
    { type: 'relation', tags: { ref: '30' }, members: [{ type: 'way', geometry: [{ lat: 49.1, lon: 8.5 }, { lat: 49.1, lon: 8.51 }] }] },
    { type: 'relation', tags: {}, members: [] },
    { type: 'way', geometry: [] },
  ];
  const m = waysByRef(el);
  assert.equal(m.size, 1);
  assert.equal(m.get('30').length, 2);
});
