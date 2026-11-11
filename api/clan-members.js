import * as cheerio from 'cheerio';
import { resolveClanMembersLink } from './_clan-links.js';

const RANKING_URL = 'https://ninjazenshin.online/clan-ranking';
const USER_AGENT = { 'User-Agent': 'Mozilla/5.0 (bleed-site)' };
const TIMEOUT = 8000;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const rawId = req.query && typeof req.query.id === 'string' ? req.query.id : '';
  if (!/^[1-9]\\d{0,9}$/.test(rawId)) {
    return res.status(400).json({ error: 'a valid clan id is required' });
  }

  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'a valid clan id is required' });
  }

  try {
    // Resolve the requested ID from the current public ranking table. This
    // prevents the endpoint from becoming an arbitrary URL proxy.
    const rankingResponse = await fetch(RANKING_URL, {
      headers: USER_AGENT,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!rankingResponse.ok) throw new Error('Clan ranking source HTTP ' + rankingResponse.status);

    const $ = cheerio.load(await rankingResponse.text());
    let selected = null;

    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 2) return;

      const link = resolveClanMembersLink(cells.eq(1).find('a').first().attr('href'));
      if (link && link.id === id) {
        selected = { id: link.id, href: link.href, name: cells.eq(1).text().trim() };
      }
    });

    if (!selected) {
      return res.status(404).json({ error: 'This clan does not currently expose a member list.' });
    }

    const rosterResponse = await fetch(selected.href, {
      headers: USER_AGENT,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!rosterResponse.ok) throw new Error('Clan roster source HTTP ' + rosterResponse.status);

    const source = await rosterResponse.json();
    if (!source || !Array.isArray(source.members)) {
      throw new Error('Clan roster source returned an invalid payload');
    }

    const seen = new Set();
    const members = source.members.map(member => {
      const name = typeof member?.name === 'string' ? member.name.trim() : '';
      return {
        name,
        level: numberOrNull(member?.level),
        rep: numberOrNull(member?.rep),
      };
    }).filter(member => {
      if (!member.name || seen.has(member.name)) return false;
      seen.add(member.name);
      return true;
    }).sort((a, b) => (b.rep || 0) - (a.rep || 0) || a.name.localeCompare(b.name));

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      id: selected.id,
      name: selected.name || (typeof source.name === 'string' ? source.name : 'Clan'),
      reputation: numberOrNull(source.reputation),
      members,
    });
  } catch (error) {
    console.error('Clan member lookup failed:', error && error.message ? error.message : error);
    return res.status(502).json({ error: 'The live clan roster could not be loaded. Please try again.' });
  }
}
