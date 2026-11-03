import { getLive, send } from './_live.mjs';

// Pünktlichkeit je Linie, gesammelt bei jedem Live-Abruf und in Vercel Blob gespeichert.
export default async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return send(res, 200, { unsupported: true, days: 0, lines: [] }, 3600);
  try {
    const rt = await getLive();
    rt.lastFlush = 0;
    rt.flushStats();
    send(res, 200, rt.statsSummary(), 600);
  } catch (e) {
    send(res, 502, { error: String(e.message || e), days: 0, lines: [] }, 30);
  }
}
