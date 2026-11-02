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

export async function handle(path, params = {}) {
  const model = await getModel();
  switch (path) {
    case '/api/meta':
      return { bbox: model.meta.bbox, feedVersion: model.meta.feedVersion, built: model.meta.built, routes: model.routes };
    case '/api/stops':
      return model.stops;
    case '/api/network':
      return model.network();
    case '/api/shapes':
      throw new Error('keine Gleisgeometrien in der statischen Version');
    case '/api/vehicles': {
      const bbox = params.bbox ? String(params.bbox).split(',').map(Number) : null;
      let types = null;
      if (params.types) {
        types = new Set();
        for (const key of String(params.types).split(',')) (TYPE_GROUPS[key] || []).forEach((t) => types.add(t));
      }
      return model.vehicles(String(params.date), Number(params.t0), Number(params.t1), bbox, types);
    }
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
