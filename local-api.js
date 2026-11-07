// Statische Variante: beantwortet dieselben /api-Aufrufe direkt im Browser aus model.json.
// Wird nur geladen, wenn window.STRAB_STATIC gesetzt ist (siehe scripts/build-static.mjs).

import { Model } from './model.js';

// In der App (STRAB_DATA_URL): neueste Daten von der Webseite holen, sonst die mitgelieferten
export async function fetchData(name, timeoutMs = 12000) {
  const remote = window.STRAB_DATA_URL;
  if (remote) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(remote + name, { signal: ctrl.signal, cache: 'no-cache' });
      clearTimeout(timer);
      if (r.ok) return await r.json();
    } catch { /* offline: mitgelieferte Datei */ }
  }
  const r = await fetch('./' + name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

let modelPromise = null;
function getModel() {
  if (!modelPromise) modelPromise = fetchData('model.json', 20000).then((json) => new Model(json));
  return modelPromise;
}

const TYPE_GROUPS = { tram: [0, 1], rail: [2], fern: [100], bus: [3, 11], other: [4, 5, 6, 7, 12] };

// Start/Ziel: Station (from) oder Punkt (fromLat, fromLon)
function spec(params, prefix) {
  if (params[prefix] !== undefined && params[prefix] !== null && params[prefix] !== '') return Number(params[prefix]);
  return { lat: Number(params[`${prefix}Lat`]), lon: Number(params[`${prefix}Lon`]) };
}

export async function handle(path, params = {}) {
  const model = await getModel();
  switch (path) {
    case '/api/meta':
      return { realtime: false, bbox: model.meta.bbox, feedVersion: model.meta.feedVersion, feedStart: model.meta.feedStart || '', feedEnd: model.meta.feedEnd || '', feeds: model.meta.feeds || [], built: model.meta.built, routes: model.routes };
    case '/api/stops':
      return model.stops;
    case '/api/network':
      return model.network();
    case '/api/shapes': {
      const shapes = await fetchData('shapes.json');
      const model = await getModel();
      if (shapes.meta && shapes.meta.modelBuilt !== model.meta.built) throw new Error('Gleisgeometrie passt nicht zum Fahrplan');
      return shapes;
    }
    case '/api/vehicles': {
      const bbox = params.bbox ? String(params.bbox).split(',').map(Number) : null;
      let types = null;
      if (params.types) {
        types = new Set();
        for (const key of String(params.types).split(',')) (TYPE_GROUPS[key] || []).forEach((t) => types.add(t));
      }
      return model.vehicles(String(params.date), Number(params.t0), Number(params.t1), bbox, types);
    }
    case '/api/line':
      return model.line(String(params.name || ''));
    case '/api/plan':
      return model.plan(spec(params, 'from'), spec(params, 'to'), String(params.date), Number(params.t), { accessible: params.acc === '1' || params.acc === 1 }).slice(0, 5);
    case '/api/profile':
      return model.profile(spec(params, 'from'), spec(params, 'to'), String(params.date), undefined, undefined, undefined, { accessible: params.acc === '1' || params.acc === 1 });
    case '/api/last':
      return model.lastJourney(spec(params, 'from'), spec(params, 'to'), String(params.date), Number(params.t), { accessible: params.acc === '1' || params.acc === 1 });
    case '/api/disruptions':
      return model.disruptions(String(params.date));
    case '/api/reach':
      return model.reach(Number(params.station), String(params.date), Number(params.t), Number(params.max) || 30);
    case '/api/frequency':
      return model.frequency(String(params.date), Number(params.t0), Number(params.t1));
    case '/api/search':
      return model.search(String(params.q || ''));
    case '/api/departures': {
      const from = Number(params.from);
      return model.departures(Number(params.station), String(params.date), from, from + 4 * 3600, Math.min(Number(params.limit) || 60, 200));
    }
    default:
      throw new Error(`unbekannter Endpunkt ${path}`);
  }
}
