import { waitUntil } from '@vercel/functions';
import { getLive, getModel, send, addHit, unitsForMap } from './_live.mjs';
import { kvvSeen, sweepHubs, cancelsForMap } from './_kvv.mjs';

export default async function handler(req, res) {
  // Anonymer Zähler: der erste Abruf nach dem App-Start trägt ?hit=web|app (nur eine Zahl je Tag, keine Kennung).
  // Läuft über diese Funktion, weil sie die Statistik ohnehin speichert: keine zusätzlichen Schreibzugriffe.
  const hit = new URL(req.url, 'http://x').searchParams.get('hit');
  if (hit) addHit(hit);
  try {
    const rt = await getLive();
    // Knotenpunkte beim KVV nachfragen, nach der Antwort (die Ergebnisse kommen mit dem nächsten Abruf)
    try { waitUntil(getModel().then((m) => sweepHubs(m)).catch(() => {})); } catch { /* lokal ohne Vercel */ }
    // Nach einer Pause liefert das CDN sofort den letzten Stand (bis 10 Min. alt) und holt im Hintergrund frisch
    // KVV-Verspätungen der letzten 4 Minuten mitgeben: genauer als gtfs.de, die Karte bevorzugt sie
    const now = Date.now(); const k = {};
    for (const [trip, v] of kvvSeen) if (now - v.at < 4 * 60 * 1000) k[trip] = v.d;
    send(res, 200, { ...rt.snapshot(), ...unitsForMap(), k, ...cancelsForMap() }, 20, 600);
  } catch (e) {
    send(res, 200, { enabled: true, updated: 0, error: e.message, d: {}, c: [], r: {} }, 10);
  }
}
