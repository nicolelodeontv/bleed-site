// api/activity.js
// Read-only member activity history for the Member Activity page.
// Uses saved reputation events only; never contacts the game website.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const REST = `${SUPABASE_URL}/rest/v1`;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'activity data is not configured' });
  }

  try {
    const [activityResponse, statsResponse, stateResponse] = await Promise.all([
      fetch(REST + '/chaos_member_daily_activity?select=day,member,gain,events,last_total,last_gain_at&order=day.asc,gain.desc&limit=2000', { headers: H }),
      fetch(REST + '/chaos_member_gain_stats?select=member,gain_24h,gain_7d,gain_30d,last_gain_at&order=gain_30d.desc', { headers: H }),
      fetch(REST + '/bleed_state?id=eq.1&select=chaos_snapshot,chaos_snapshot_at', { headers: H }),
    ]);

    if (!activityResponse.ok) throw new Error('Activity history read failed: ' + activityResponse.status);
    if (!statsResponse.ok) throw new Error('Member totals read failed: ' + statsResponse.status);
    if (!stateResponse.ok) throw new Error('Current roster read failed: ' + stateResponse.status);

    const [activity, stats, stateRows] = await Promise.all([
      activityResponse.json(), statsResponse.json(), stateResponse.json(),
    ]);
    const state = stateRows[0] || {};
    const snapshot = state.chaos_snapshot && typeof state.chaos_snapshot === 'object' ? state.chaos_snapshot : {};

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');
    return res.status(200).json({
      generated_at: Date.now(),
      snapshot_at: Number(state.chaos_snapshot_at) || 0,
      members: Array.isArray(snapshot.members) ? snapshot.members : [],
      activity: Array.isArray(activity) ? activity : [],
      stats: Array.isArray(stats) ? stats : [],
      timezone: 'Asia/Manila',
    });
  } catch (e) {
    return res.status(502).json({ error: e && e.message ? e.message : 'activity data unavailable' });
  }
}
