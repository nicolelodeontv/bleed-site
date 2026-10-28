const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Finished bleeds from the last 24h, newest first.
export default async function handler(req, res) {
  try {
    const since = Date.now() - 24 * 3600e3;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/bleed_events?select=name,since,last_drop,lost,ended_at&ended_at=gte.${since}&order=ended_at.desc&limit=50`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw new Error('Supabase read failed: ' + r.status);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ events: await r.json() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
