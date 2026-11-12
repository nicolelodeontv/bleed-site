import { aggregateHourly, clampHours } from './_hourly.js';

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLAN = process.env.CHAOS_CLAN || 'Chaos';

// Chaos rep gained per hour (overall and per member) for the last N hours, N = ?hours= (1-72, default 24).
// Served by /api/history?view=chaos-hourly (a helper file, not its own route: the Vercel Hobby plan allows 12 functions).
export async function handleChaosHourly(req, res) {
  try {
    const hours = clampHours(req.query && req.query.hours);
    const now = Date.now();
    const since = Math.floor(now / 3600e3) * 3600e3 - (hours - 1) * 3600e3;
    const url = `${SUPABASE_URL}/rest/v1/rep_gains?select=at,member,gain&clan=eq.${encodeURIComponent(CLAN)}` +
      `&at=gte.${since}&order=at.asc&limit=10000`;
    const r = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Supabase read failed: ' + r.status);
    const out = aggregateHourly(await r.json(), now, hours);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ clan: CLAN, timezone: 'Asia/Manila', generated_at: now, hours, ...out });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
