import { runTick } from './_lib.js';

// The page calls this. If the shared state is older than 15s, it refreshes it first.
// If the source is down, runTick returns the last good state with stale: true.
export default async function handler(req, res) {
  try {
    const s = await runTick(15000);
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
    res.status(200).json({ checked_at: s.checked_at, bleeding: s.bleeding, clans: s.clans, stale: !!s.stale });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
