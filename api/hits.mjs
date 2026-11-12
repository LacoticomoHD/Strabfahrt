import { hitsByDay, send } from './_live.mjs';

// App-Starts je Tag (anonym gezählt), neueste zuerst
export default async function handler(req, res) {
  try {
    send(res, 200, { days: await hitsByDay() }, 300);
  } catch (e) {
    send(res, 200, { days: [], error: String(e.message || e) }, 30);
  }
}
