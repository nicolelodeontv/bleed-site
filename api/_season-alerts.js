// api/_season-alerts.js
// Durable, retryable Discord delivery for automatically detected Chaos season rollovers.

const { SUPABASE_URL, DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_WEBHOOK_URL,
  DISCORD_ROLE_ID, SITE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const REST = SUPABASE_URL ? SUPABASE_URL + '/rest/v1' : '';
const H = {
  apikey: KEY,
  Authorization: 'Bearer ' + KEY,
  'Content-Type': 'application/json',
};
const TIMEOUT = 10000;
const LEASE_MS = 45000;
const HAS_BOT = !!(DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID);
const HAS_WEBHOOK = !!DISCORD_WEBHOOK_URL;
const SITE = (SITE_URL || 'https://bleed-site-tawny.vercel.app').replace(/\/+$/, '');

const safeText = value => String(value == null ? '' : value)
  .replace(/([\\*_~\`|>])/g, '\\$1')
  .replace(/@/g, '@\u200b')
  .slice(0, 72);

async function updateClaim(alert, patch) {
  const query = new URLSearchParams({
    id: 'eq.' + alert.id,
    status: 'eq.sending',
    attempt_count: 'eq.' + alert.attempt_count,
  });
  const response = await fetch(REST + '/chaos_season_alerts?' + query.toString(), {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) throw new Error('Season alert status update failed: HTTP ' + response.status);
  const rows = await response.json();
  return Array.isArray(rows) && rows.length === 1;
}

function makeDiscordPayload(alert) {
  const payload = alert.payload && typeof alert.payload === 'object' ? alert.payload : {};
  const season = Number(payload.season_number || alert.season_number);
  const previousSeason = Number(payload.previous_season_number || alert.previous_season_number);
  const startedAt = Number(payload.started_at || alert.created_at || Date.now());
  const top5 = Array.isArray(payload.previous_top5) ? payload.previous_top5.slice(0, 5) : [];
  const baselineMembers = Number(payload.baseline_member_count) || 0;
  const baselineRep = Number(payload.baseline_total_rep) || 0;

  const topLines = top5.length
    ? top5.map((row, index) =>
        '**' + (index + 1) + '.** ' + safeText(row.member) +
        ' · **+' + Number(row.gain || 0).toLocaleString('en-US') + ' rep**'
      ).join('\n')
    : 'No positive member gains were recorded in the previous tracked season.';

  const pingRole = process.env.PING_ENABLED === 'true' && DISCORD_ROLE_ID;
  const embed = {
    color: 0xf5c542,
    title: '🏆 Chaos Season ' + season + ' has started!',
    description:
      'A broad reputation reset was detected and the tracker has opened a new season. ' +
      'Member reputation gains will now be counted from the new baseline.',
    fields: [
      {
        name: '🗓️ New season',
        value: '**Season ' + season + '** · <t:' + Math.floor(startedAt / 1000) + ':F>\n<t:' +
          Math.floor(startedAt / 1000) + ':R>',
        inline: true,
      },
      {
        name: '📊 New baseline',
        value: '**' + baselineMembers.toLocaleString('en-US') + ' members**\n' +
          '**' + baselineRep.toLocaleString('en-US') + ' total rep**',
        inline: true,
      },
      {
        name: '🥇 Previous season top 5 · Season ' + previousSeason,
        value: topLines,
        inline: false,
      },
    ],
    footer: { text: 'Bleed Watch · automatic season rollover' },
    timestamp: new Date(startedAt).toISOString(),
  };

  return {
    content: pingRole ? '<@&' + DISCORD_ROLE_ID + '>' : undefined,
    allowed_mentions: pingRole ? { roles: [DISCORD_ROLE_ID] } : { parse: [] },
    embeds: [embed],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'Open Season ' + season + ' leaderboard',
        url: SITE + '/seasons.html?season=' + encodeURIComponent(season),
      }],
    }],
    // Discord checks a nonce for uniqueness over the past few minutes.
    // Reusing this season-specific nonce prevents a timed-out retry from posting twice.
    nonce: 'season-rollover-' + season,
    enforce_nonce: true,
  };
}

async function postWithBot(payload) {
  const response = await fetch('https://discord.com/api/v10/channels/' +
    encodeURIComponent(DISCORD_CHANNEL_ID) + '/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    return { ok: false, status: response.status, detail };
  }
  const message = await response.json();
  return { ok: true, message_id: message && message.id ? String(message.id) : null };
}

async function postWithWebhook(payload) {
  const endpoint = new URL(DISCORD_WEBHOOK_URL);
  endpoint.searchParams.set('wait', 'true');
  const webhookPayload = { ...payload };
  delete webhookPayload.nonce;
  delete webhookPayload.enforce_nonce;
  delete webhookPayload.components; // webhook fallback is a compact announcement only
  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookPayload),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    throw new Error('Discord webhook failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  const message = await response.json();
  return message && message.id ? String(message.id) : null;
}

async function deliver(payload) {
  if (HAS_BOT) {
    const result = await postWithBot(payload);
    if (result.ok) return result.message_id;
    if (!HAS_WEBHOOK) {
      throw new Error('Discord bot send failed: HTTP ' + result.status +
        (result.detail ? ' · ' + result.detail : ''));
    }
    // Only fall back after a definitive HTTP rejection. Network errors/timeouts
    // are allowed to retry through the nonce-protected bot path.
    console.error('Season rollover bot send rejected; trying configured webhook:', result.status);
  } else if (!HAS_WEBHOOK) {
    throw new Error('No Discord bot/channel or webhook is configured');
  }
  return postWithWebhook(payload);
}

export async function dispatchSeasonRolloverAlert() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }
  if (!HAS_BOT && !HAS_WEBHOOK) {
    return { status: 'not_configured', reason: 'Discord bot/channel or webhook is not configured' };
  }

  const claimResponse = await fetch(REST + '/rpc/claim_chaos_season_alert', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now(), p_lease_ms: LEASE_MS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!claimResponse.ok) {
    const detail = (await claimResponse.text()).slice(0, 350);
    throw new Error('Season alert claim failed: HTTP ' + claimResponse.status +
      (detail ? ' · ' + detail : ''));
  }

  const claimed = await claimResponse.json();
  const alert = Array.isArray(claimed) ? claimed[0] : null;
  if (!alert) return { status: 'idle' };

  const now = Date.now();
  try {
    const messageId = await deliver(makeDiscordPayload(alert));
    const marked = await updateClaim(alert, {
      status: 'sent',
      discord_message_id: messageId,
      sent_at: Date.now(),
      lease_until: 0,
      last_error: null,
      updated_at: Date.now(),
    });
    if (!marked) {
      console.error('Season rollover delivered but could not confirm outbox status', alert.season_number);
      return { status: 'sent_unconfirmed', season_number: alert.season_number };
    }
    return {
      status: 'sent',
      season_number: Number(alert.season_number),
      message_id: messageId,
      attempt_count: Number(alert.attempt_count),
    };
  } catch (error) {
    const attempt = Math.max(1, Number(alert.attempt_count) || 1);
    const backoff = Math.min(4 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));
    const failureAt = Date.now();
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    try {
      await updateClaim(alert, {
        status: 'failed',
        next_attempt_at: failureAt + backoff,
        lease_until: 0,
        last_error: message,
        updated_at: failureAt,
      });
    } catch (updateError) {
      console.error('Could not schedule season alert retry:', String(updateError.message || updateError).slice(0, 300));
    }
    console.error('Season rollover Discord alert failed:', message);
    return {
      status: 'retry_scheduled',
      season_number: Number(alert.season_number),
      attempt_count: attempt,
      retry_after_ms: backoff,
    };
  }
}
