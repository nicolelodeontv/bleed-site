import * as cheerio from 'cheerio';

const SRC = 'https://ninjazenshin.online/clan-ranking';

export default async function handler(req, res) {
  try {
    const r = await fetch(SRC, { headers: { 'User-Agent': 'Mozilla/5.0 (bleed-site)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const $ = cheerio.load(await r.text());

    const clans = [];
    $('table tr').each((_, tr) => {
      const td = $(tr).find('td').map((_, c) => $(c).text().trim()).get();
      if (td.length < 5) return; // # | Clan | Master | Members | Reputation
      const rep = parseInt(td[4].replace(/,/g, ''), 10);
      if (Number.isNaN(rep)) return;
      clans.push({ rank: parseInt(td[0], 10), name: td[1], master: td[2], members: td[3], rep });
    });
    if (!clans.length) throw new Error('No clans parsed - table selector may need adjusting');

    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
    res.status(200).json({ updated: Date.now(), clans });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
