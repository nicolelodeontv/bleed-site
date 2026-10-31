// api/member-seasons.js
// Read-only cross-season history for one Chaos member.
// Ranks are calculated within each recorded season; missing seasons remain unreported.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL + '/rest/v1';

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
    return res.status(500).json({ error: 'cross-season history is not configured' });
  }

  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'a valid member name is required' });
  }

  try {
    const memberQuery = new URLSearchParams({
      select: 'season_number,member,starting_rep,current_rep,season_gain,gain_events,active_days,last_gain_at,last_gain_day,updated_at',
      member: 'eq.' + name,
      order: 'season_number.desc',
      limit: '100',
    });
    const seasonsQuery = new URLSearchParams({
      select: 'season_number,started_at,ended_at,status,start_reason,end_reason',
      order: 'season_number.desc',
      limit: '100',
    });
    const rankingsQuery = new URLSearchParams({
      select: 'season_number,member,season_gain',
      order: 'season_number.asc,season_gain.desc,member.asc',
      limit: '10000',
    });

    const [seasons, memberRows, rankingRows] = await Promise.all([
      read('/chaos_seasons?' + seasonsQuery.toString(), 'Season history'),
      read('/chaos_season_member_stats?' + memberQuery.toString(), 'Member season history'),
      read('/chaos_season_member_stats?' + rankingsQuery.toString(), 'Season ranking totals'),
    ]);

    if (!Array.isArray(seasons) || !seasons.length) {
      return res.status(404).json({ error: 'No Chaos seasons have been recorded yet.' });
    }

    const rankings = Array.isArray(rankingRows) ? rankingRows : [];
    const ownRows = new Map((Array.isArray(memberRows) ? memberRows : [])
      .map(row => [Number(row.season_number), row]));
    const cohorts = new Map();
    for (const row of rankings) {
      const number = Number(row.season_number);
      if (!cohorts.has(number)) cohorts.set(number, []);
      cohorts.get(number).push(row);
    }

    const history = seasons.map(season => {
      const number = Number(season.season_number);
      const own = ownRows.get(number) || null;
      const cohort = cohorts.get(number) || [];
      const orderedCohort = cohort.slice().sort((a,b) =>
        Number(b.season_gain || 0) - Number(a.season_gain || 0) ||
        String(a.member).localeCompare(String(b.member))
      );
      const gain = own ? Number(own.season_gain || 0) : null;
      const rank = own ? orderedCohort.findIndex(row => row.member === name) + 1 : null;
      return {
        season_number: number,
        started_at: Number(season.started_at) || 0,
        ended_at: season.ended_at == null ? null : Number(season.ended_at),
        status: season.status,
        start_reason: season.start_reason,
        end_reason: season.end_reason || null,
        tracked: !!own,
        rank,
        ranked_members: own ? cohort.length : 0,
        starting_rep: own ? Number(own.starting_rep || 0) : null,
        current_rep: own ? Number(own.current_rep || 0) : null,
        season_gain: gain,
        gain_events: own ? Number(own.gain_events || 0) : null,
        active_days: own ? Number(own.active_days || 0) : null,
        last_gain_at: own && own.last_gain_at != null ? Number(own.last_gain_at) : null,
      };
    });

    const recorded = history.filter(row => row.tracked);
    const totalGain = recorded.reduce((sum, row) => sum + Number(row.season_gain || 0), 0);
    const bestRank = recorded.reduce((best, row) => row.rank == null ? best :
      (best == null || row.rank < best ? row.rank : best), null);
    const bestSeason = bestRank == null ? null : recorded.find(row => row.rank === bestRank);
    const currentSeason = history.find(row => row.status === 'active') || null;
    const previousRecorded = recorded.length > 1 ? recorded[1] : null;
    const currentTracked = currentSeason && currentSeason.tracked ? currentSeason : null;
    const previousGainDelta = currentTracked && previousRecorded
      ? currentTracked.season_gain - previousRecorded.season_gain : null;

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      name,
      season_count: recorded.length,
      total_recorded_gain: totalGain,
      total_gain_events: recorded.reduce((sum, row) => sum + Number(row.gain_events || 0), 0),
      total_active_days: recorded.reduce((sum, row) => sum + Number(row.active_days || 0), 0),
      best_rank: bestRank,
      best_rank_season: bestSeason ? bestSeason.season_number : null,
      active_season_number: currentSeason ? currentSeason.season_number : null,
      active_season_tracked: !!currentTracked,
      previous_recorded_gain: previousRecorded ? previousRecorded.season_gain : null,
      current_vs_previous_gain: previousGainDelta,
      history,
    });
  } catch (error) {
    return res.status(502).json({ error: error && error.message ? error.message : 'cross-season history unavailable' });
  }
}
