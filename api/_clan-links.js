const GAME_ORIGIN = 'https://ninjazenshin.online';

export function parseClanId(value) {
  if (typeof value !== 'string' || !/^[1-9]\\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function resolveClanMembersLink(href) {
  if (typeof href !== 'string' || !href.trim()) return null;

  try {
    const url = new URL(href, GAME_ORIGIN);
    if (url.origin !== GAME_ORIGIN) return null;

    const match = /^\/clan-ranking\/members\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) return null;

    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return null;

    return { id, href: url.origin + url.pathname };
  } catch {
    return null;
  }
}
