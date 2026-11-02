import { send } from './_live.mjs';

// Ohne dauerhaften Speicher gibt es keine Statistik. Die App zeigt einen Hinweis.
export default function handler(req, res) {
  send(res, 200, { unsupported: true, days: 0, lines: [] }, 3600);
}
