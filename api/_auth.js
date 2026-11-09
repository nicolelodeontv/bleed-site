import crypto from 'node:crypto';

// Shared check for the scheduler endpoints (/api/tick and the cron mode of /api/members).
// Accepts the secret as "Authorization: Bearer <secret>" (what Vercel Cron sends) or as the
// older ?key=<secret> query parameter, so existing external schedulers keep working.
// It never authorizes when no secret is configured.

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

export function getCredential(req) {
  const header = req && req.headers && req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '').trim();
  }
  const key = req && req.query && req.query.key;
  return typeof key === 'string' && key ? key : '';
}

export function isAuthorized(req, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const credential = getCredential(req);
  if (!credential) return false;
  // Hash first so the comparison is constant-time and length-independent.
  return crypto.timingSafeEqual(digest(credential), digest(secret));
}
