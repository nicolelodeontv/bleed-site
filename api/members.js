// api/members.js
// Shared member feed: one server-side Chaos game read every 5 seconds for all visitors.
// The other tracked clans retain their existing 20-second shared poll.

const { SUPABASE_URL, CRON_SECRET, TRACK_CLANS } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const REST = `${SUPABASE_URL}/rest/v1`;
const SRC = 'https://ninjazenshin.online/clan-ranking/members/';
const CHAOS_ID = 3;
// 3 Chaos, 2 Filipino Clan, 6 Darkness Of Abyss, 36 Knock You Up, 24 Sagrada Familia.
// Chaos is polled separately at 5 seconds; avoid racing its member_rep rows here.
const IDS = (TRACK_CLANS || '3,2,6,36,24').split(',').map(s => s.trim()).filter(Boolean);
const OTHER_IDS = IDS.filter(id => Number(id) !== CHAOS_ID);
const KEEP = 24 * 3600e3;
const POLL_COOLDOWN = 20_000;
const CHAOS_POLL_COOLDOWN = 5_000;

async function pollClan(id, now) {
  const r = await fetch(SRC + id, { headers: { 'User-Agent': 'Mozilla/5.0 (bleed-site)' } });
  if (!r.ok) return { id, error: 'HTTP ' + r.status };
  const d = await r.json();
  const seen = new Set();
  const members = (Array.isArray(d.members) ? d.members : []).filter(m => {
    if (!m.name || !m.name.trim() || seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });
  if (!members.length) return { id, error: 'no members' };

  const o = await fetch(`${REST}/member_rep?clan_id=eq.${id}&select=name,rep`, { headers: H });
  if (!o.ok) throw new Error('Supabase read failed: ' + o.status);
  const old = await o.json();
  const prev = Object.fromEntries(old.map(m => [m.name, m.rep]));

  // Season reset guard: if many members dropped at once, just store the new baseline.
  const dropped = members.filter(m => prev[m.name] !== undefined && m.rep < prev[m.name]).length;
  const reset = old.length > 0 && dropped > Math.max(3, members.length / 2);

  const gains = [];
  if (old.length && !reset) {
    for (const m of members) {
      if (prev[m.name] !== undefined && m.rep > prev[m.name]) {
        gains.push({ at: now, clan_id: Number(id), clan: d.name, member: m.name, gain: m.rep - prev[m.name], total: m.rep });
      }
    }
  }

  const up = await fetch(`${REST}/member_rep`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(members.map(m => ({ clan_id: Number(id), name: m.name, rep: m.rep }))),
  });
  if (!up.ok) throw new Error('Supabase upsert failed: ' + up.status);

  if (gains.length) {
    const ins = await fetch(`${REST}/rep_gains`, { method: 'POST', headers: H, body: JSON.stringify(gains) });
    if (!ins.ok) throw new Error('Supabase insert failed: ' + ins.status);
  }
  return { id, clan: d.name, gains: gains.length, reset };
}

async function claimOtherPoll(now) {
  if (!OTHER_IDS.length) return false;
  const claim = await fetch(REST + '/bleed_state?id=eq.1&members_checked_at=lt.' + (now - POLL_COOLDOWN), {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ members_checked_at: now }),
  });
  if (!claim.ok) throw new Error('Supabase poll claim failed: ' + claim.status);
  const rows = await claim.json();
  return Array.isArray(rows) && rows.length === 1;
}

async function claimChaosPoll(now) {
  const claim = await fetch(REST + '/bleed_state?id=eq.1&chaos_checked_at=lt.' + (now - CHAOS_POLL_COOLDOWN), {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ chaos_checked_at: now, chaos_sync_error: null }),
  });
  if (!claim.ok) throw new Error('Supabase Chaos poll claim failed: ' + claim.status);
  const rows = await claim.json();
  return Array.isArray(rows) && rows.length === 1;
}

async function runPoll(now) {
  const out = await Promise.all(OTHER_IDS.map(async id => {
    try { return await pollClan(id, now); }
    catch (e) { return { id, error: e.message }; }
  }));
  const cleanup = await fetch(REST + '/rep_gains?at=lt.' + (now - KEEP), { method: 'DELETE', headers: H });
  if (!cleanup.ok) throw new Error('Supabase cleanup failed: ' + cleanup.status);
  return out;
}

async function pollChaos(now) {
  const response = await fetch(SRC + CHAOS_ID, {
    headers: { 'User-Agent': 'Mozilla/5.0 (bleed-site)' },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error('Game members request failed: HTTP ' + response.status);
  const source = await response.json();
  if (!Array.isArray(source.members)) throw new Error('Game returned an invalid members list');

  const seen = new Set();
  const members = source.members.filter(m => {
    const name = String(m.name || '').trim();
    const rep = Number(m.rep);
    if (!name || seen.has(name) || !Number.isFinite(rep) || rep < 0) return false;
    seen.add(name);
    return true;
  }).map(m => ({
    name: String(m.name).trim(),
    rep: Math.trunc(Number(m.rep)),
    level: m.level == null ? null : m.level,
  }));
  if (!members.length) throw new Error('Game returned an empty members list');

  const oldResponse = await fetch(`${REST}/member_rep?clan_id=eq.${CHAOS_ID}&select=name,rep`, { headers: H });
  if (!oldResponse.ok) throw new Error('Supabase member baseline read failed: ' + oldResponse.status);
  const old = await oldResponse.json();
  const prev = Object.fromEntries(old.map(m => [m.name, m.rep]));

  // Avoid turning a season reset into hundreds of false positive member gains.
  const dropped = members.filter(m => prev[m.name] !== undefined && m.rep < prev[m.name]).length;
  const reset = old.length > 0 && dropped > Math.max(3, members.length / 2);
  const gains = [];
  if (old.length && !reset) {
    for (const m of members) {
      if (prev[m.name] !== undefined && m.rep > prev[m.name]) {
        gains.push({
          at: now, clan_id: CHAOS_ID, clan: String(source.name || 'Chaos'),
          member: m.name, gain: m.rep - prev[m.name], total: m.rep,
        });
      }
    }
  }

  const up = await fetch(REST + '/member_rep', {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(members.map(m => ({ clan_id: CHAOS_ID, name: m.name, rep: m.rep }))),
  });
  if (!up.ok) throw new Error('Supabase Chaos baseline upsert failed: ' + up.status);

  if (gains.length) {
    const ins = await fetch(REST + '/rep_gains', {
      method: 'POST', headers: H, body: JSON.stringify(gains),
    });
    if (!ins.ok) throw new Error('Supabase Chaos gains insert failed: ' + ins.status);
  }

  const snapshot = {
    name: String(source.name || 'Chaos'),
    reputation: Number(source.reputation) || 0,
    members,
  };
  const saved = await fetch(REST + '/bleed_state?id=eq.1', {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({
      chaos_snapshot: snapshot,
      chaos_snapshot_at: now,
      chaos_sync_error: null,
    }),
  });
  if (!saved.ok) throw new Error('Supabase Chaos snapshot save failed: ' + saved.status);

  return { members: members.length, gains: gains.length, reset };
}

async function runChaosPoll(now) {
  try {
    return await pollChaos(now);
  } catch (e) {
    const message = String(e && e.message || e).slice(0, 400);
    try {
      await fetch(REST + '/bleed_state?id=eq.1', {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ chaos_sync_error: message }),
      });
    } catch {}
    return { error: message };
  }
}

async function readSharedFeed(now) {
  const [stateResponse, gainsResponse] = await Promise.all([
    fetch(REST + '/bleed_state?id=eq.1&select=chaos_snapshot,chaos_snapshot_at,chaos_sync_error', { headers: H }),
    fetch(REST + '/rep_gains?at=gte.' + (now - 3600e3) + '&order=at.desc&limit=300&select=at,clan,member,gain,total', { headers: H }),
  ]);
  if (!stateResponse.ok) throw new Error('Supabase shared snapshot read failed: ' + stateResponse.status);
  if (!gainsResponse.ok) throw new Error('Supabase gains read failed: ' + gainsResponse.status);
  const rows = await stateResponse.json();
  const gains = await gainsResponse.json();
  const state = rows[0] || {};
  const snapshot = state.chaos_snapshot && typeof state.chaos_snapshot === 'object' ? state.chaos_snapshot : {};
  return {
    name: snapshot.name || 'Chaos',
    reputation: Number(snapshot.reputation) || 0,
    members: Array.isArray(snapshot.members) ? snapshot.members : [],
    snapshot_at: Number(state.chaos_snapshot_at) || 0,
    sync_error: state.chaos_sync_error || null,
    now: Date.now(),
    gains,
  };
}

export default async function handler(req, res) {
  try {
    if (req.query.key) {
      if (req.query.key !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
      const now = Date.now();
      const [otherClaimed, chaosClaimed] = await Promise.all([
        claimOtherPoll(now), claimChaosPoll(now),
      ]);
      const [polled, chaos] = await Promise.all([
        otherClaimed ? runPoll(now) : Promise.resolve({ skipped: true, reason: 'recent poll' }),
        chaosClaimed ? runChaosPoll(now) : Promise.resolve({ skipped: true, reason: 'recent poll' }),
      ]);
      return res.status(200).json({ ok: true, polled, chaos });
    }

    // Every visitor asks for the same database snapshot. Only the request that
    // wins the atomic five-second claim contacts the game; all others read it.
    const now = Date.now();
    const [otherClaimed, chaosClaimed] = await Promise.all([
      claimOtherPoll(now), claimChaosPoll(now),
    ]);
    const jobs = [];
    if (otherClaimed) jobs.push(runPoll(now));
    if (chaosClaimed) jobs.push(runChaosPoll(now));
    if (jobs.length) await Promise.all(jobs);

    const feed = await readSharedFeed(now);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json(feed);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
