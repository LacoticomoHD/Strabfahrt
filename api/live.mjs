// Eine einzige Funktion für alle Live-Endpunkte. Vorher lief jeder Endpunkt als eigene Vercel-Funktion
// mit eigener Instanz: jede lud den Fahrplan (17 MB) und holte und entpackte den Live-Feed selbst.
// Jetzt teilen sich alle denselben Speicher und denselben Abruf (vercel.json leitet /api/<name> hierher).
import delays from './_r_delays.mjs';
import alerts from './_r_alerts.mjs';
import departures from './_r_departures.mjs';
import tripstops from './_r_tripstops.mjs';
import stats from './_r_stats.mjs';
import trip from './_r_trip.mjs';
import hits from './_r_hits.mjs';
import stopevents from './_r_stopevents.mjs';
import report from './_r_report.mjs';
import { send } from './_live.mjs';

const ROUTES = { delays, alerts, departures, tripstops, stats, trip, hits, stopevents, report };

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // Name aus ?f= (nach der Umleitung) oder aus dem Pfad /api/<name>
  const name = url.searchParams.get('f') || url.pathname.split('/').filter(Boolean).pop();
  const route = ROUTES[name];
  if (!route) return send(res, 404, { error: `unbekannter Endpunkt: ${name}` }, 60);
  return route(req, res);
}
