// api/members.js
// With ?key=CRON_SECRET  -> polls the tracked clans and records rep gains (call from cron-job.org every 1 min)
// Without a key          -> returns the recent gains for the fights page

const { SUPABASE_URL, CRON_SECRET, TRACK_CLANS } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const REST = `${SUPABASE_URL}/rest/v1`;
const SRC = 'https://ninjazenshin.online/clan-ranking/members/';
// 3 Chaos, 2 Filipino Clan, 6 Darkness Of Abyss, 36 Knock You Up, 24 Sagrada Familia
const IDS = (TRACK_CLANS || '3,2,6,36,24').split(',').map(s => s.trim()).filter(Boolean);
const KEEP = 24 * 3600e3;

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

  // Season reset guard: if many members dropped at once, just store the new baseline
  const dropped = members.filter(m => prev[m.name] !== undefined && m.rep < prev[m.name]).length;
  const reset = old.length > 0 && dropped > Math.max(3, members.length / 2);

  const gains = [];
  if (old.length && !reset) {
    for (const m of members) {
      if (prev[m.name] !== undefined && m.rep > prev[m.name]) {
        gains.push({ at: now, clan_id: Number(id), clan: d.name, member: m.name, gain: m.rep - prev[m.name] });
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

export default async function handler(req, res) {
  try {
    if (req.query.key) {
      if (req.query.key !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
      const now = Date.now();
      const out = await Promise.all(IDS.map(async id => {
        try { return await pollClan(id, now); }
        catch (e) { return { id, error: e.message }; }
      }));
      await fetch(`${REST}/rep_gains?at=lt.${now - KEEP}`, { method: 'DELETE', headers: H });
      return res.status(200).json({ ok: true, polled: out });
    }
    const since = Date.now() - 3600e3;
    const r = await fetch(`${REST}/rep_gains?at=gte.${since}&order=at.desc&limit=300&select=at,clan,member,gain`, { headers: H });
    if (!r.ok) throw new Error('Supabase read failed: ' + r.status);
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.status(200).json({ now: Date.now(), gains: await r.json() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
