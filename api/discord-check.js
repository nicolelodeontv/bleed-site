const { DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, CRON_SECRET } = process.env;

async function discord(path) {
  const r = await fetch('https://discord.com/api/v10' + path, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  let body = {};
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Fail closed if the diagnostic secret is not configured.
  if (!CRON_SECRET || typeof req.query.key !== 'string' || req.query.key !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) {
    return res.status(503).json({
      error: 'discord_config_missing',
      hasBotToken: Boolean(DISCORD_BOT_TOKEN),
      hasChannelId: Boolean(DISCORD_CHANNEL_ID),
    });
  }

  try {
    const [me, channel] = await Promise.all([
      discord('/users/@me'),
      discord(`/channels/${encodeURIComponent(DISCORD_CHANNEL_ID.trim())}`),
    ]);

    return res.status(200).json({
      bot: {
        status: me.status,
        validToken: me.status === 200,
        username: me.body?.username ?? null,
        id: me.body?.id ?? null,
        error: me.body?.message ?? null,
        code: me.body?.code ?? null,
      },
      channelId: {
        length: DISCORD_CHANNEL_ID.trim().length,
        looksLikeSnowflake: /^[0-9]{17,20}$/.test(DISCORD_CHANNEL_ID.trim()),
      },
      channel: {
        status: channel.status,
        name: channel.body?.name ?? null,
        type: channel.body?.type ?? null,
        guild_id: channel.body?.guild_id ?? null,
        error: channel.body?.message ?? null,
        code: channel.body?.code ?? null,
      },
      note: 'Discord bot tokens cannot reliably use the OAuth2 current-user guild list endpoint. The channel response above directly tests access to the configured channel.',
    });
  } catch {
    return res.status(502).json({ error: 'discord_api_request_failed' });
  }
}
