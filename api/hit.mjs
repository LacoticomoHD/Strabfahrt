import { addHit, getLiveSoon } from './_live.mjs';

// Anonymer Zähler: ein Aufruf je App-Start. Es wird nur eine Zahl je Tag erhöht, keine IP, keine Kennung.
export default async function handler(req, res) {
  const kind = new URL(req.url, 'http://x').searchParams.get('p') === 'app' ? 'app' : 'web';
  addHit(kind);
  getLiveSoon(1); // stößt bei Bedarf das Speichern mit an, ohne zu warten
  res.statusCode = 204;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}
