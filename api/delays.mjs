import { getLive, send, addHit } from './_live.mjs';

export default async function handler(req, res) {
  // Anonymer Zähler: der erste Abruf nach dem App-Start trägt ?hit=web|app (nur eine Zahl je Tag, keine Kennung).
  // Läuft über diese Funktion, weil sie die Statistik ohnehin speichert: keine zusätzlichen Schreibzugriffe.
  const hit = new URL(req.url, 'http://x').searchParams.get('hit');
  if (hit) addHit(hit);
  try {
    const rt = await getLive();
    // Nach einer Pause liefert das CDN sofort den letzten Stand (bis 10 Min. alt) und holt im Hintergrund frisch
    send(res, 200, rt.snapshot(), 60, 600);
  } catch (e) {
    send(res, 200, { enabled: true, updated: 0, error: e.message, d: {}, c: [], r: {} }, 10);
  }
}
