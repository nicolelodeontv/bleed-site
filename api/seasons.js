// api/seasons.js
// Read-only Chaos season history and leaderboard.
// Uses the persistent season ledger; never contacts the game website.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL + '/rest/v1';

async function read(path, label) {
  const response = await fetch(REST + path, { headers: H });
  if (!response.ok) throw new Error(label + ' read failed: ' + response.status);
  return response.json();
}

function summarizeSeason(season, allStats, allMilestones) {
  const rows = allStats.filter(row => Number(row.season_number) === Number(season.season_number));
  const ranked = rows.slice().sort((a,b) =>
    Number(b.season_gain || 0) - Number(a.season_gain || 0) ||
    String(a.member).localeCompare(String(b.member))
  );
  const top = ranked.find(row => Number(row.season_gain || 0) > 0);
  const milestones = allMilestones.filter(row =>
    Number(row.season_number) === Number(season.season_number)
  );
  return {
    ...season,
    total_gain: rows.reduce((sum,row) => sum + Number(row.season_gain || 0), 0),
    gain_events: rows.reduce((sum,row) => sum + Number(row.gain_events || 0), 0),
    active_members: rows.filter(row => Number(row.season_gain || 0) > 0).length,
    tracked_members: rows.length,
    top_member: top ? top.member : null,
    top_member_gain: top ? Number(top.season_gain || 0) : 0,
    milestone_unlocks: milestones.length,
    major_milestone_unlocks: milestones.filter(row => row.is_major).length,
    members_with_milestones: new Set(milestones.map(row => row.member)).size,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'season tracking is not configured' });
  }

  const hasSeason = req.query.season !== undefined && req.query.season !== '';
  const requestedSeason = hasSeason && typeof req.query.season === 'string'
    ? Number(req.query.season) : null;
  if (hasSeason && (!Number.isSafeInteger(requestedSeason) || requestedSeason < 1)) {
    return res.status(400).json({ error: 'invalid season number' });
  }

  try {
    const [seasons, allStats, allMilestones] = await Promise.all([
      read('/chaos_seasons?select=season_number,started_at,ended_at,status,start_reason,end_reason&order=season_number.desc&limit=100', 'Season history'),
      read('/chaos_season_member_stats?select=season_number,member,starting_rep,current_rep,season_gain,gain_events,active_days,last_gain_at,last_gain_day,current_streak_days,longest_streak_days,last_streak_day,updated_at&order=season_number.desc,season_gain.desc&limit=10000', 'Season member totals'),
      read('/chaos_season_milestones?select=id,season_number,member,milestone_key,milestone_value,milestone_title,metric_value,earned_at,is_major&order=season_number.desc,earned_at.desc&limit=20000', 'Season milestone totals'),
    ]);

    if (!Array.isArray(seasons) || !seasons.length) {
      return res.status(404).json({ error: 'No Chaos seasons have been recorded yet.' });
    }

    const milestoneRows = Array.isArray(allMilestones) ? allMilestones : [];
    const summaries = seasons.map(season =>
      summarizeSeason(season, Array.isArray(allStats) ? allStats : [], milestoneRows)
    );
    const active = seasons.find(season => season.status === 'active') || seasons[0];
    const selected = requestedSeason == null
      ? active
      : seasons.find(season => Number(season.season_number) === requestedSeason);

    if (!selected) return res.status(404).json({ error: 'That season was not found.' });

    const selectedMilestones = new Map();
    for (const row of milestoneRows.filter(item =>
      Number(item.season_number) === Number(selected.season_number)
    )) {
      if (!selectedMilestones.has(row.member)) selectedMilestones.set(row.member, []);
      selectedMilestones.get(row.member).push({
        id: Number(row.id),
        milestone_key: row.milestone_key,
        milestone_value: Number(row.milestone_value || 0),
        milestone_title: row.milestone_title,
        metric_value: Number(row.metric_value || 0),
        earned_at: Number(row.earned_at || 0),
        is_major: !!row.is_major,
      });
    }

    const selectedMembers = (Array.isArray(allStats) ? allStats : [])
      .filter(row => Number(row.season_number) === Number(selected.season_number))
      .sort((a,b) => Number(b.season_gain || 0) - Number(a.season_gain || 0) ||
        String(a.member).localeCompare(String(b.member)))
      .map((row,index) => ({
        ...row,
        current_streak_days: Number(row.current_streak_days || 0),
        longest_streak_days: Number(row.longest_streak_days || 0),
        milestones: selectedMilestones.get(row.member) || [],
        rank: index + 1,
      }));

    const summary = summaries.find(item => Number(item.season_number) === Number(selected.season_number));
    const previous = summaries
      .filter(item => Number(item.season_number) < Number(selected.season_number))
      .sort((a,b) => Number(b.season_number) - Number(a.season_number))[0] || null;

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      active_season_number: Number(active.season_number),
      selected_season: summary,
      previous_season: previous,
      seasons: summaries,
      members: selectedMembers,
      milestone_totals: {
        unlocks: milestoneRows.length,
        major_unlocks: milestoneRows.filter(row => row.is_major).length,
      },
    });
  } catch (error) {
    return res.status(502).json({ error: error && error.message ? error.message : 'season data unavailable' });
  }
}
