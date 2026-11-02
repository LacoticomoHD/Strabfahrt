// Statische Variante: beantwortet dieselben /api-Aufrufe direkt im Browser aus model.json.
// Wird nur geladen, wenn window.STRAB_STATIC gesetzt ist (siehe scripts/build-static.mjs).

import { Model } from './model.mjs';

let modelPromise = null;
function getModel() {
  if (!modelPromise) {
    modelPromise = fetch('./model.json').then((r) => {
      if (!r.ok) throw new Error(`model.json: HTTP ${r.status}`);
      return r.json();
    }).then((json) => new Model(json));
  }
  return modelPromise;
}

const TYPE_GROUPS = { tram: [0, 1], rail: [2], bus: [3, 11], other: [4, 5, 6, 7, 12] };

// Start/Ziel: Station (from) oder Punkt (fromLat, fromLon)
function spec(params, prefix) {
  if (params[prefix] !== undefined && params[prefix] !== null && params[prefix] !== '') return Number(params[prefix]);
  return { lat: Number(params[`${prefix}Lat`]), lon: Number(params[`${prefix}Lon`]) };
}

export async function handle(path, params = {}) {
  const model = await getModel();
  switch (path) {
    case '/api/meta':
      return { realtime: false, bbox: model.meta.bbox, feedVersion: model.meta.feedVersion, feedStart: model.meta.feedStart || '', feedEnd: model.meta.feedEnd || '', built: model.meta.built, routes: model.routes };
    case '/api/stops':
      return model.stops;
    case '/api/network':
      return model.network();
    case '/api/shapes': {
      const r = await fetch('./shapes.json');
      if (!r.ok) throw new Error('keine Gleisgeometrien vorhanden');
      return r.json();
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
      return model.plan(spec(params, 'from'), spec(params, 'to'), String(params.date), Number(params.t)).slice(0, 5);
    case '/api/profile':
      return model.profile(spec(params, 'from'), spec(params, 'to'), String(params.date));
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
