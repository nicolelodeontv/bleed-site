// api/member-activity.js
// Read-only individual Chaos member profile and recorded reputation timeline.
// Reads existing Supabase history only; never contacts the game website.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL + '/rest/v1';
const KEEP = 30 * 24 * 60 * 60 * 1000;

async function read(path, label) {
  const response = await fetch(REST + path, { headers: H });
  if (!response.ok) throw new Error(label + ' read failed: ' + response.status);
  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'member activity is not configured' });
  }

  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'a valid member name is required' });
  }
  const hasBefore = req.query.before !== undefined && req.query.before !== '';
  const before = hasBefore && typeof req.query.before === 'string' ? Number(req.query.before) : null;
  if (hasBefore && (!Number.isSafeInteger(before) || before <= 0 || before > Date.now())) {
    return res.status(400).json({ error: 'invalid activity cursor' });
  }

  try {
    const memberFilter = 'eq.' + name;
    const memberQuery = new URLSearchParams({
      select: 'member,gain_24h,gain_7d,gain_30d,last_gain_at',
      member: memberFilter,
      limit: '1',
    });
    const activityQuery = new URLSearchParams({
      select: 'day,member,gain,events,last_total,last_gain_at',
      member: memberFilter,
      order: 'day.asc',
      limit: '60',
    });
    const eventsQuery = new URLSearchParams({
      select: 'at,member,gain,total',
      clan_id: 'eq.3',
      member: memberFilter,
      at: before ? 'lt.' + before : 'gte.' + (Date.now() - KEEP),
      order: 'at.desc',
      limit: '200',
    });
    const stateQuery = new URLSearchParams({
      select: 'chaos_snapshot,chaos_snapshot_at',
      id: 'eq.1',
      limit: '1',
    });
    const seasonQuery = new URLSearchParams({
      select: 'season_number',
      member: memberFilter,
      limit: '1',
    });

    const [statsRows, history, events, stateRows, seasonRows] = await Promise.all([
      read('/chaos_member_gain_stats?' + memberQuery.toString(), 'Member totals'),
      read('/chaos_member_daily_activity?' + activityQuery.toString(), 'Daily member history'),
      read('/rep_gains?' + eventsQuery.toString(), 'Member event history'),
      read('/bleed_state?' + stateQuery.toString(), 'Current member roster'),
      read('/chaos_season_member_stats?' + seasonQuery.toString(), 'Member season history'),
    ]);

    const state = stateRows[0] || {};
    const snapshot = state.chaos_snapshot && typeof state.chaos_snapshot === 'object' ? state.chaos_snapshot : {};
    const roster = Array.isArray(snapshot.members) ? snapshot.members.slice().sort((a, b) => Number(b.rep || 0) - Number(a.rep || 0)) : [];
    const index = roster.findIndex(member => member.name === name);
    const current = index >= 0 ? roster[index] : null;
    const stats = statsRows[0] || {};

    if (!current && !history.length && !events.length && !seasonRows.length) {
      return res.status(404).json({ error: 'No current roster entry or saved history was found for this member.' });
    }

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');
    return res.status(200).json({
      generated_at: Date.now(),
      snapshot_at: Number(state.chaos_snapshot_at) || 0,
      timezone: 'Asia/Manila',
      name,
      profile: current ? {
        level: current.level == null ? null : current.level,
        reputation: Number(current.rep) || 0,
        rank: index + 1,
        roster_size: roster.length,
      } : null,
      stats: {
        gain_24h: Number(stats.gain_24h) || 0,
        gain_7d: Number(stats.gain_7d) || 0,
        gain_30d: Number(stats.gain_30d) || 0,
        last_gain_at: stats.last_gain_at || null,
      },
      history: Array.isArray(history) ? history : [],
      events: Array.isArray(events) ? events : [],
      event_limit: 200,
      has_more: Array.isArray(events) && events.length === 200,
      next_before: Array.isArray(events) && events.length ? Number(events[events.length - 1].at) : null,
    });
  } catch (error) {
    return res.status(502).json({ error: error && error.message ? error.message : 'member activity unavailable' });
  }
}
