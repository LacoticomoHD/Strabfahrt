import crypto from 'node:crypto';
import { getLive, send } from './_live.mjs';

// Fahrgast-Meldung: POST /api/report?id=<Fahrt-ID>  ->  { ok, n }
// "Ich sitze in dieser Bahn, sie steht": die Bahn bleibt dann auch bei den anderen auf der Karte stehen.
// Gespeichert wird nur eine gekürzte Prüfsumme der Adresse, gegen Mehrfachmeldungen.
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return send(res, 204, {}, 0, 0);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'nur POST' }, 0, 0);
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  if (!id || id.length > 200) return send(res, 400, { error: 'id fehlt' }, 0, 0);
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const who = crypto.createHash('sha256').update(`strab|${ip}`).digest('hex').slice(0, 12);
  try {
    const rt = await getLive();
    const r = rt.addPassengerReport(id, who);
    send(res, r.ok ? 200 : 429, r, 0, 0);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) }, 0, 0);
  }
}
