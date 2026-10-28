import crypto from 'node:crypto';

// Discord sends button clicks here. Raw body is needed to verify the signature.
export const config = { api: { bodyParser: false } };

const PUBLIC_KEY = (process.env.DISCORD_PUBLIC_KEY || '').trim();
const { DISCORD_BOT_TOKEN, DISCORD_ROLE_ID } = process.env;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // wraps a raw Ed25519 public key

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let raw = Buffer.concat(chunks);
  // Fallback if the platform already parsed the body
  if (!raw.length && req.body != null) {
    raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  }
  return raw;
}

function verified(raw, sig, ts) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(PUBLIC_KEY, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), raw]), key, Buffer.from(sig, 'hex'));
  } catch { return false; }
}

const reply = (res, content) => res.status(200).json({ type: 4, data: { content, flags: 64 } });

export default async function handler(req, res) {
  // Open this URL in a browser to check the setup (shows lengths and yes/no only, never values)
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      publicKeyLength: PUBLIC_KEY.length,   // should be 64
      hasBotToken: Boolean(DISCORD_BOT_TOKEN),
      hasRoleId: Boolean(DISCORD_ROLE_ID),
    });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readBody(req);
  if (PUBLIC_KEY.length !== 64) return res.status(401).send('public key missing or wrong length: ' + PUBLIC_KEY.length);
  if (!raw.length) return res.status(401).send('empty request body');
  if (!verified(raw, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'])) {
    return res.status(401).send('invalid request signature');
  }
  const i = JSON.parse(raw.toString('utf8'));

  if (i.type === 1) return res.status(200).json({ type: 1 });          // Discord's endpoint check

  if (i.type === 3 && i.data?.custom_id === 'bleed_toggle') {
    const has = i.member.roles.includes(DISCORD_ROLE_ID);
    const r = await fetch(`https://discord.com/api/v10/guilds/${i.guild_id}/members/${i.member.user.id}/roles/${DISCORD_ROLE_ID}`, {
      method: has ? 'DELETE' : 'PUT', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });
    if (!r.ok) return reply(res, 'Could not update your role. The bot needs Manage Roles, and its role must sit above the alert role.');
    return reply(res, has ? '🔕 Bleed alerts turned off.' : '🔔 Bleed alerts turned on. You\'ll be pinged when a clan starts bleeding.');
  }
  return reply(res, 'Unknown action.');
}
