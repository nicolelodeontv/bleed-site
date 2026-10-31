// api/hall-of-fame.js
// Read-only permanent Chaos season award archive.

const { SUPABASE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const REST = SUPABASE_URL + '/rest/v1';

async function read(path, label) {
  const response = await fetch(REST + path, { headers: H });
  if (!response.ok) throw new Error(label + ' read failed: ' + response.status);
  return response.json();
}

const CATEGORY_ORDER = {
  season_champion: 1,
  most_active: 2,
  consistency: 3,
  most_recorded_increases: 4,
};

function metricLabel(key) {
  if (key === 'active_days') return 'active days';
  if (key === 'longest_streak_days') return 'consecutive active days';
  if (key === 'gain_events') return 'recorded increases';
  return 'reputation gained';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: 'Hall of Fame is not configured' });
  }

  try {
    const awardsQuery = new URLSearchParams({
      select: 'season_number,award_key,award_title,metric_key,winning_value,winners,eligible_count,decided_at,award_version',
      order: 'season_number.desc,decided_at.desc,award_key.asc',
      limit: '2000',
    });
    const seasonsQuery = new URLSearchParams({
      select: 'season_number,started_at,ended_at,status,start_reason,end_reason',
      order: 'season_number.desc',
      limit: '100',
    });

    const [awardRows, seasons] = await Promise.all([
      read('/chaos_season_awards?' + awardsQuery.toString(), 'Hall of Fame awards'),
      read('/chaos_seasons?' + seasonsQuery.toString(), 'Season history'),
    ]);

    const seasonByNumber = new Map((Array.isArray(seasons) ? seasons : [])
      .map(season => [Number(season.season_number), season]));
    const totals = new Map();
    const normalizedAwards = (Array.isArray(awardRows) ? awardRows : []).map(award => {
      const winners = (Array.isArray(award.winners) ? award.winners : [])
        .filter(winner => winner && typeof winner.member === 'string')
        .map(winner => ({
          member: winner.member,
          value: Number(winner.value == null ? award.winning_value : winner.value),
        }))
        .sort((a,b) => a.member.localeCompare(b.member));
      const season = seasonByNumber.get(Number(award.season_number)) || null;
      const item = {
        season_number: Number(award.season_number),
        award_key: award.award_key,
        award_title: award.award_title,
        metric_key: award.metric_key,
        metric_label: metricLabel(award.metric_key),
        winning_value: Number(award.winning_value || 0),
        winners,
        winner_count: winners.length,
        eligible_count: Number(award.eligible_count || 0),
        decided_at: Number(award.decided_at || 0),
        award_version: Number(award.award_version || 1),
        season_started_at: season ? Number(season.started_at || 0) : null,
        season_ended_at: season && season.ended_at != null ? Number(season.ended_at) : null,
        season_status: season ? season.status : 'unknown',
      };

      for (const winner of winners) {
        if (!totals.has(winner.member)) {
          totals.set(winner.member, {
            member: winner.member,
            award_count: 0,
            champion_count: 0,
            award_seasons: new Set(),
            awards: [],
          });
        }
        const total = totals.get(winner.member);
        total.award_count++;
        if (award.award_key === 'season_champion') total.champion_count++;
        total.award_seasons.add(item.season_number);
        total.awards.push({
          season_number: item.season_number,
          award_key: item.award_key,
          award_title: item.award_title,
          value: winner.value,
        });
      }
      return item;
    }).sort((a,b) =>
      b.season_number - a.season_number ||
      (CATEGORY_ORDER[a.award_key] || 99) - (CATEGORY_ORDER[b.award_key] || 99) ||
      a.award_title.localeCompare(b.award_title)
    );

    const leaders = Array.from(totals.values()).map(total => ({
      member: total.member,
      award_count: total.award_count,
      champion_count: total.champion_count,
      seasons_awarded: total.award_seasons.size,
      award_seasons: Array.from(total.award_seasons).sort((a,b) => b-a),
      awards: total.awards,
    })).sort((a,b) =>
      b.award_count - a.award_count ||
      b.champion_count - a.champion_count ||
      a.member.localeCompare(b.member)
    );

    const grouped = (Array.isArray(seasons) ? seasons : []).map(season => ({
      season_number: Number(season.season_number),
      started_at: Number(season.started_at || 0),
      ended_at: season.ended_at == null ? null : Number(season.ended_at),
      status: season.status,
      awards: normalizedAwards.filter(award =>
        Number(award.season_number) === Number(season.season_number)
      ),
    }));

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');
    return res.status(200).json({
      generated_at: Date.now(),
      timezone: 'Asia/Manila',
      total_awards: normalizedAwards.length,
      total_winners: Array.from(new Set(normalizedAwards.flatMap(award =>
        award.winners.map(winner => winner.member)
      ))).length,
      season_count: grouped.length,
      leaders,
      awards: normalizedAwards,
      seasons: grouped,
    });
  } catch (error) {
    return res.status(502).json({
      error: error && error.message ? error.message : 'Hall of Fame unavailable',
    });
  }
}
