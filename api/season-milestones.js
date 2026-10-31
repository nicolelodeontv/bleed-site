// api/season-milestones.js
// Live milestone progress for the active season plus the permanent unlock archive.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL + '/rest/v1';

const THRESHOLDS = {
  season_gain: [1000, 5000, 10000, 25000, 50000],
  active_days: [7, 14, 30],
  streak_days: [7, 14, 30],
};

async function read(path, label) {
  const response = await fetch(REST + path, { headers: H });
  if (!response.ok) throw new Error(label + ' read failed: ' + response.status);
  return response.json();
}

function dayInManila(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return value.year + '-' + value.month + '-' + value.day;
}

function getCurrentStreak(row, today) {
  if (!row.last_streak_day) return 0;
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  return row.last_streak_day === today || row.last_streak_day === yesterday
    ? Number(row.current_streak_days || 0) : 0;
}

function nextProgress(key, value) {
  const levels = THRESHOLDS[key];
  const next = levels.find(level => Number(value || 0) < level);
  if (next == null) return {
    current: Number(value || 0),
    next: null,
    next_label: 'All milestones unlocked',
    percent: 100,
  };
  return {
    current: Number(value || 0),
    next,
    next_label: next.toLocaleString('en-US'),
    percent: Math.max(0, Math.min(100, Math.round(Number(value || 0) / next * 100))),
  };
}

function sortMilestones(rows) {
  const order = { season_gain: 1, active_days: 2, streak_days: 3 };
  return rows.slice().sort((a,b) =>
    (order[a.milestone_key] || 99) - (order[b.milestone_key] || 99) ||
    Number(a.milestone_value) - Number(b.milestone_value)
  );
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'season milestones are not configured' });
  }

  try {
    const [seasons, allMilestones] = await Promise.all([
      read('/chaos_seasons?select=season_number,started_at,ended_at,status&order=season_number.desc&limit=100', 'Season history'),
      read('/chaos_season_milestones?select=id,season_number,member,milestone_key,milestone_value,milestone_title,metric_value,earned_at,is_major&order=earned_at.desc,id.desc&limit=20000', 'Milestone history'),
    ]);
    if (!Array.isArray(seasons) || !seasons.length) {
      return res.status(404).json({ error: 'No Chaos seasons have been recorded yet.' });
    }

    const active = seasons.find(season => season.status === 'active') || seasons[0];
    const activeQuery = new URLSearchParams({
      select: 'season_number,member,season_gain,gain_events,active_days,current_streak_days,longest_streak_days,last_streak_day',
      season_number: 'eq.' + active.season_number,
      order: 'season_gain.desc,member.asc',
      limit: '1000',
    });
    const activeStats = await read('/chaos_season_member_stats?' + activeQuery.toString(), 'Active season member progress');
    const milestoneRows = Array.isArray(allMilestones) ? allMilestones : [];
    const currentRows = milestoneRows.filter(row =>
      Number(row.season_number) === Number(active.season_number)
    );
    const byMember = new Map();
    for (const row of currentRows) {
      if (!byMember.has(row.member)) byMember.set(row.member, []);
      byMember.get(row.member).push(row);
    }

    const now = Date.now();
    const today = dayInManila(new Date(now));
    const members = (Array.isArray(activeStats) ? activeStats : []).map(row => {
      const currentStreak = getCurrentStreak(row, today);
      const unlocked = sortMilestones(byMember.get(row.member) || []).map(item => ({
        id: Number(item.id),
        milestone_key: item.milestone_key,
        milestone_value: Number(item.milestone_value),
        milestone_title: item.milestone_title,
        metric_value: Number(item.metric_value),
        earned_at: Number(item.earned_at),
        is_major: !!item.is_major,
      }));
      return {
        member: row.member,
        season_gain: Number(row.season_gain || 0),
        gain_events: Number(row.gain_events || 0),
        active_days: Number(row.active_days || 0),
        current_streak_days: currentStreak,
        best_streak_days: Number(row.longest_streak_days || 0),
        earned_count: unlocked.length,
        milestones: unlocked,
        progress: {
          season_gain: nextProgress('season_gain', row.season_gain),
          active_days: nextProgress('active_days', row.active_days),
          streak_days: nextProgress('streak_days', currentStreak),
        },
      };
    }).sort((a,b) =>
      b.earned_count - a.earned_count ||
      b.season_gain - a.season_gain ||
      a.member.localeCompare(b.member)
    );

    const leaderMap = new Map();
    for (const row of milestoneRows) {
      if (!leaderMap.has(row.member)) leaderMap.set(row.member, {
        member: row.member,
        total_unlocks: 0,
        major_unlocks: 0,
        season_numbers: new Set(),
      });
      const leader = leaderMap.get(row.member);
      leader.total_unlocks++;
      if (row.is_major) leader.major_unlocks++;
      leader.season_numbers.add(Number(row.season_number));
    }
    const all_time_leaders = Array.from(leaderMap.values()).map(row => ({
      member: row.member,
      total_unlocks: row.total_unlocks,
      major_unlocks: row.major_unlocks,
      seasons_with_unlocks: row.season_numbers.size,
    })).sort((a,b) =>
      b.total_unlocks - a.total_unlocks ||
      b.major_unlocks - a.major_unlocks ||
      a.member.localeCompare(b.member)
    ).slice(0, 50);

    const recent_unlocks = milestoneRows.slice(0, 30).map(row => ({
      id: Number(row.id),
      season_number: Number(row.season_number),
      member: row.member,
      milestone_key: row.milestone_key,
      milestone_value: Number(row.milestone_value),
      milestone_title: row.milestone_title,
      metric_value: Number(row.metric_value),
      earned_at: Number(row.earned_at),
      is_major: !!row.is_major,
    }));

    const season_summary = seasons.map(season => {
      const rows = milestoneRows.filter(row =>
        Number(row.season_number) === Number(season.season_number)
      );
      return {
        season_number: Number(season.season_number),
        status: season.status,
        started_at: Number(season.started_at || 0),
        ended_at: season.ended_at == null ? null : Number(season.ended_at),
        unlocks: rows.length,
        members_with_unlocks: new Set(rows.map(row => row.member)).size,
        major_unlocks: rows.filter(row => row.is_major).length,
      };
    });

    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
    return res.status(200).json({
      generated_at: now,
      timezone: 'Asia/Manila',
      active_season: {
        season_number: Number(active.season_number),
        started_at: Number(active.started_at || 0),
        member_count: members.length,
        unlocks: currentRows.length,
        major_unlocks: currentRows.filter(row => row.is_major).length,
        total_season_gain: members.reduce((sum,row) => sum + row.season_gain, 0),
        total_active_days: members.reduce((sum,row) => sum + row.active_days, 0),
      },
      thresholds: THRESHOLDS,
      members,
      recent_unlocks,
      all_time_leaders,
      season_summary,
      total_unlocks: milestoneRows.length,
      total_major_unlocks: milestoneRows.filter(row => row.is_major).length,
    });
  } catch (error) {
    return res.status(502).json({
      error: error && error.message ? error.message : 'season milestone data unavailable',
    });
  }
}
