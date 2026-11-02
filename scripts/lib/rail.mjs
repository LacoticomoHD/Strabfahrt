// Kleine Graph-Bausteine fuer das Gleis-Matching. Reine Funktionen, keine Netzwerkzugriffe.

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function distance(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const CELL = 0.002; // Grad, rund 200 m
const cellKey = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;

// ways: Liste von Linienzuegen, jeder eine Liste von [lat, lon]. Gemeinsame Koordinaten verbinden Wege.
export function buildGraph(ways) {
  const ids = new Map();
  const coords = [];
  const adj = [];
  const grid = new Map();
  const nodeId = (p) => {
    const key = `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = coords.length;
      ids.set(key, id);
      coords.push([p[0], p[1]]);
      adj.push([]);
      const ck = cellKey(p[0], p[1]);
      if (!grid.has(ck)) grid.set(ck, []);
      grid.get(ck).push(id);
    }
    return id;
  };
  for (const way of ways) {
    for (let i = 1; i < way.length; i++) {
      const a = nodeId(way[i - 1]);
      const b = nodeId(way[i]);
      if (a === b) continue;
      const w = distance(coords[a], coords[b]);
      adj[a].push([b, w]);
      adj[b].push([a, w]);
    }
  }
  return { coords, adj, grid };
}

export function nearestNode(graph, lat, lon, maxMeters) {
  const cy = Math.floor(lat / CELL);
  const cx = Math.floor(lon / CELL);
  const reach = Math.ceil(maxMeters / 200) + 1;
  let best = -1;
  let bestD = maxMeters;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const list = graph.grid.get(`${cy + dy},${cx + dx}`);
      if (!list) continue;
      for (const id of list) {
        const d = distance([lat, lon], graph.coords[id]);
        if (d <= bestD) { best = id; bestD = d; }
      }
    }
  }
  return best;
}

class MinHeap {
  constructor() { this.a = []; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// Kuerzester Weg zwischen zwei Knoten, bricht bei maxCost ab. Gibt Knotenliste oder null zurueck.
export function shortestPath(graph, from, to, maxCost = Infinity) {
  if (from === to) return [from];
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const heap = new MinHeap();
  heap.push([0, from]);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === to) {
      const path = [u];
      let c = u;
      while (prev.has(c)) { c = prev.get(c); path.push(c); }
      return path.reverse();
    }
    if (d > maxCost) return null;
    for (const [v, w] of graph.adj[u]) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity) && nd <= maxCost) {
        dist.set(v, nd);
        prev.set(v, u);
        heap.push([nd, v]);
      }
    }
  }
  return null;
}

// Douglas-Peucker, Toleranz in Metern (lokale Naeherung)
export function simplify(points, epsMeters) {
  if (points.length < 3) return points;
  const kx = Math.cos(rad(points[0][0])) * 111320;
  const ky = 110540;
  const px = points.map((p) => [p[1] * kx, p[0] * ky]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    const [ax, ay] = px[s];
    const [bx, by] = px[e];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((by - ay) * px[i][0] - (bx - ax) * px[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsMeters && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Verbindet zwei Haltepunkte ueber das Netz. Gibt Punktliste oder null zurueck.
export function matchSegment(graph, a, b, { snapMeters = 150, detour = 3, slack = 400 } = {}) {
  const straight = distance(a, b);
  const na = nearestNode(graph, a[0], a[1], snapMeters);
  const nb = nearestNode(graph, b[0], b[1], snapMeters);
  if (na < 0 || nb < 0) return null;
  const maxCost = Math.max(straight * detour, straight + slack);
  const path = shortestPath(graph, na, nb, maxCost);
  if (!path) return null;
  return simplify([a, ...path.map((id) => graph.coords[id]), b], 2);
}

// Overpass-Antwort mit Linienrelationen (out geom) -> Wege je Liniennummer (ref).
// Jede Relation liefert die Stuecke, die diese Linie tatsaechlich befaehrt.
export function waysByRef(elements) {
  const out = new Map();
  for (const el of elements || []) {
    if (el.type !== 'relation' || !el.tags || !el.tags.ref || !Array.isArray(el.members)) continue;
    const list = out.get(el.tags.ref) || [];
    for (const m of el.members) {
      if (m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length > 1) list.push(m.geometry.map((g) => [g.lat, g.lon]));
    }
    if (list.length) out.set(el.tags.ref, list);
  }
  return out;
}
