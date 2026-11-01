import { getChaosClanHealth } from './seasons.js';
import { deliver, safeText } from './_season-alerts.js';

const { SUPABASE_URL, DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_WEBHOOK_URL, SITE_URL } = process.env;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const REST = SUPABASE_URL ? SUPABASE_URL + '/rest/v1' : '';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const TIMEOUT = 10000;
const LEASE_MS = 45000;
const HAS_DISCORD = !!((DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID) || DISCORD_WEBHOOK_URL);
const SITE = (SITE_URL || 'https://bleed-site-tawny.vercel.app').replace(/\/+$/, '');

function addDays(value, amount) {
  const date = new Date(String(value).slice(0, 10) + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function manilaToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export async function queueChaosClanHealthAlerts() {
  if (!SUPABASE_URL || !KEY) return { status: 'not_configured' };

  const data = await getChaosClanHealth();
  const health = data && data.health ? data.health : {};
  if (!health.available || !Number.isFinite(Number(health.score)) ||
      !['healthy', 'watch', 'high'].includes(health.risk_level)) {
    return {
      status: 'baseline_building',
      season_number: data && data.season ? Number(data.season.season_number) : null,
      consecutive_snapshot_days: data && data.coverage
        ? Number(data.coverage.consecutive_snapshot_days || 0) : 0,
      required_snapshot_days: 15,
    };
  }

  const today = manilaToday();
  const monday = new Date(today + 'T12:00:00Z').getUTCDay() === 1;
  const payload = {
    season_number: Number(data.season.season_number),
    as_of: health.as_of,
    score: Number(health.score),
    previous_score: health.previous_score == null ? null : Number(health.previous_score),
    score_change: health.score_change == null ? null : Number(health.score_change),
    risk_level: health.risk_level,
    summary: data.summary || {},
    metrics: health.metrics || {},
    components: health.components || {},
    flags: Array.isArray(health.flags) ? health.flags.slice(0, 8) : [],
    generated_at: Number(data.generated_at || Date.now()),
  };
  const response = await fetch(REST + '/rpc/queue_chaos_clan_health_alerts', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      p_season_number: Number(data.season.season_number),
      p_risk_level: health.risk_level,
      p_score: Number(health.score),
      p_payload: payload,
      p_today: today,
      p_week_start: monday ? addDays(today, -7) : null,
      p_week_end: monday ? addDays(today, -1) : null,
      p_now: Date.now(),
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    throw new Error('Clan Health queue failed: HTTP ' + response.status + (detail ? ' · ' + detail : ''));
  }
  const result = await response.json();
  return result && typeof result === 'object'
    ? { ...result, score: Number(health.score), risk_level: health.risk_level }
    : { status: 'unknown' };
}

async function finishAlert(alert, status, options = {}) {
  const response = await fetch(REST + '/rpc/finish_chaos_clan_health_alert', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      p_id: Number(alert.id),
      p_attempt_count: Number(alert.attempt_count),
      p_status: status,
      p_now: Date.now(),
      p_message_id: options.message_id || null,
      p_error: options.error || null,
      p_retry_at: Number(options.retry_at || 0),
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error('Clan Health completion failed: HTTP ' + response.status + (detail ? ' · ' + detail : ''));
  }
  return response.json();
}

function makeEmbed(alert) {
  const p = alert.payload && typeof alert.payload === 'object' ? alert.payload : {};
  const season = Number(p.season_number || alert.season_number || 0);
  const risk = ['healthy', 'watch', 'high'].includes(p.risk_level) ? p.risk_level : 'watch';
  const score = Number(p.score || 0);
  const summary = p.summary || {};
  const metrics = p.metrics || {};
  const components = p.components || {};
  const flags = Array.isArray(p.flags) ? p.flags.slice(0, 6) : [];
  const riskLabel = risk === 'high' ? 'HIGH RISK' : risk === 'watch' ? 'WATCH' : 'HEALTHY';
  const flagLines = flags.map(flag =>
    '• **' + safeText(flag.title) + '** · ' + safeText(flag.detail).slice(0, 170)
  ).join('\n').slice(0, 1024);

  if (alert.event_type === 'risk_change') {
    const previous = String(p.previous_risk_level || 'unknown').toUpperCase();
    const worse = risk === 'high' || (risk === 'watch' && p.previous_risk_level === 'healthy');
    const fields = [
      { name: 'Health score', value: '**' + score + ' / 100**', inline: true },
      { name: 'Current risk', value: '**' + riskLabel + '**', inline: true },
      { name: 'Previous state', value: previous, inline: true },
    ];
    if (flagLines) fields.push({ name: 'Risk indicators', value: flagLines, inline: false });
    return {
      color: risk === 'high' ? 0xff6975 : risk === 'watch' ? 0xf5c542 : 0x3ecf8e,
      title: (worse ? '⚠️' : '✅') + ' Clan Health changed · Season ' + season,
      description: 'Risk moved from **' + previous + '** to **' + risk.toUpperCase() +
        '** · ' + (worse ? 'activity risk increased.' : 'activity risk improved.') +
        (p.as_of ? '\nAs of ' + p.as_of + ' · Manila time.' : ''),
      fields,
      footer: { text: 'Bleed Watch · automated risk transition' },
      timestamp: new Date(Number(p.generated_at || Date.now())).toISOString(),
    };
  }

  const participation = components.participation || {};
  const momentum = components.momentum || {};
  const balance = components.balance || {};
  const retention = components.retention || {};
  const fields = [
    { name: '🛡️ Clan Health', value: '**' + score + ' / 100** · **' + riskLabel + '**', inline: true },
    { name: '👥 Participation', value: '**' + Number(participation.value || 0) + '/' +
      Number(participation.denominator || 0) + '** · ' + Number(participation.score || 0) + '%', inline: true },
    { name: '📈 Weekly momentum', value: '**+' + Number(metrics.current_7d_gain || 0).toLocaleString('en-US') +
      ' rep** · ' + Number(metrics.current_7d_active_members || 0) + ' active', inline: true },
    { name: '⚖️ Contribution balance', value: Number(balance.top_share_percent || 0) +
      '% from top 20% · ' + Number(balance.score || 0) + '/100', inline: true },
    { name: '🔁 Member retention', value: Number(retention.retained_members || 0) + '/' +
      Number(retention.previous_active_members || 0) + ' retained · ' + Number(retention.score || 0) + '/100', inline: true },
    { name: 'Previous week', value: '+' + Number(metrics.previous_7d_gain || 0).toLocaleString('en-US') +
      ' rep · ' + Number(metrics.previous_7d_active_members || 0) + ' active', inline: true },
  ];
  if (flagLines) fields.push({ name: 'Risk indicators', value: flagLines, inline: false });
  return {
    color: risk === 'high' ? 0xff6975 : risk === 'watch' ? 0xf5c542 : 0x3ecf8e,
    title: '📊 Clan Health weekly report · Season ' + season,
    description: '**' + String(p.week_start || '') + ' – ' + String(p.week_end || '') +
      '** · completed Manila calendar week',
    fields,
    footer: { text: 'Bleed Watch · weekly health summary · Asia/Manila' },
    timestamp: new Date(Number(p.generated_at || Date.now())).toISOString(),
  };
}

export async function dispatchChaosClanHealthAlerts() {
  if (!SUPABASE_URL || !KEY) return { status: 'not_configured' };
  if (!HAS_DISCORD) return { status: 'not_configured', reason: 'Discord is not configured' };

  const response = await fetch(REST + '/rpc/claim_chaos_clan_health_alerts', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now(), p_limit: 10, p_lease_ms: LEASE_MS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    throw new Error('Clan Health claim failed: HTTP ' + response.status + (detail ? ' · ' + detail : ''));
  }
  const claimed = await response.json();
  const alerts = Array.isArray(claimed) ? claimed : [];
  if (!alerts.length) return { status: 'idle' };

  try {
    const nonce = 'ch-' + String(alerts[0].id).slice(-8) + '-' +
      String(alerts[alerts.length - 1].id).slice(-8);
    const messageId = await deliver({
      allowed_mentions: { parse: [] },
      embeds: alerts.slice(0, 10).map(makeEmbed),
      components: [{
        type: 1,
        components: [
          { type: 2, style: 5, label: 'Open Clan Health', url: SITE + '/clan-health.html' },
          { type: 2, style: 5, label: 'Member Retention', url: SITE + '/retention.html' },
        ],
      }],
      nonce,
      enforce_nonce: true,
    });

    let confirmed = 0;
    for (const alert of alerts) {
      try {
        if (await finishAlert(alert, 'sent', { message_id: messageId }) === true) confirmed++;
      } catch (error) {
        console.error('Clan Health delivered but status was not confirmed:',
          Number(alert.id), String(error && error.message || error).slice(0, 250));
      }
    }
    return confirmed === alerts.length
      ? { status: 'sent', alerts: alerts.length, season_number: Number(alerts[0].season_number), message_id: messageId }
      : { status: 'sent_unconfirmed', alerts: alerts.length, confirmed };
  } catch (error) {
    const now = Date.now();
    let rescheduled = 0;
    for (const alert of alerts) {
      const attempt = Math.max(1, Number(alert.attempt_count) || 1);
      const backoff = Math.min(4 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));
      try {
        if (await finishAlert(alert, 'failed', {
          error: String(error && error.message ? error.message : error).slice(0, 500),
          retry_at: now + backoff,
        }) === true) rescheduled++;
      } catch (updateError) {
        console.error('Could not schedule Clan Health retry:',
          Number(alert.id), String(updateError.message || updateError).slice(0, 250));
      }
    }
    console.error('Clan Health Discord delivery failed:',
      String(error && error.message ? error.message : error).slice(0, 500));
    return { status: 'retry_scheduled', alerts: alerts.length, rescheduled };
  }
}
