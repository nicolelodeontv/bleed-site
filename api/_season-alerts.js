import { getChaosClanHealth } from './seasons.js';
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

export const safeText = value => String(value == null ? '' : value)
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
  const awards = Array.isArray(payload.previous_awards) ? payload.previous_awards : [];
  const baselineMembers = Number(payload.baseline_member_count) || 0;
  const baselineRep = Number(payload.baseline_total_rep) || 0;

  const topLines = top5.length
    ? top5.map((row, index) =>
        '**' + (index + 1) + '.** ' + safeText(row.member) +
        ' · **+' + Number(row.gain || 0).toLocaleString('en-US') + ' rep**'
      ).join('\n')
    : 'No positive member gains were recorded in the previous tracked season.';

  const awardLines = awards.length
    ? awards.map(award => {
        const winners = Array.isArray(award.winners) ? award.winners : [];
        const rawMetric = Number(award.winning_value || 0);
        const metric = award.award_key === 'most_improved'
          ? (rawMetric / 1000).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
          : rawMetric.toLocaleString('en-US');
        const unit = award.award_key === 'most_active' || award.award_key === 'consistency'
          ? ' days'
          : award.award_key === 'most_recorded_increases' ? ' recorded increases'
            : award.award_key === 'most_improved' ? ' rep/day improved' : ' rep';
        const awardTitle = award.award_key === 'season_champion' ? 'Season MVP' : award.award_title;
        const visibleWinners = winners.slice(0, 2).map(winner => safeText(winner.member).slice(0, 40));
        if (winners.length > visibleWinners.length) {
          visibleWinners.push('+' + (winners.length - visibleWinners.length) + ' more in Hall of Fame');
        }
        const names = visibleWinners.join(', ');
        return '**' + safeText(awardTitle) + '** · ' + names + ' · **' + metric + unit + '**';
      }).join('\\n')
    : 'No award met the positive-activity requirements in the previous tracked season.';

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
      {
        name: '🏅 Season ' + previousSeason + ' awards',
        value: awardLines,
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
      }, {
        type: 2,
        style: 5,
        label: 'Hall of Fame',
        url: SITE + '/hall-of-fame.html',
      }],
    }],
    // Discord checks a nonce for uniqueness over the past few minutes.
    // Reusing this season-specific nonce prevents a timed-out retry from posting twice.
    nonce: 'sr-' + season,
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

export async function deliver(payload) {
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


async function updateMilestoneClaim(alert, patch) {
  const query = new URLSearchParams({
    id: 'eq.' + alert.id,
    status: 'eq.sending',
    attempt_count: 'eq.' + alert.attempt_count,
  });
  const response = await fetch(REST + '/chaos_milestone_alerts?' + query.toString(), {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    throw new Error('Milestone alert status update failed: HTTP ' + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length === 1;
}

function makeMilestoneDiscordPayload(alert) {
  const payload = alert.payload && typeof alert.payload === 'object' ? alert.payload : {};
  const season = Number(payload.season_number || alert.season_number);
  const unlocked = Array.isArray(payload.unlocked) ? payload.unlocked : [];
  const visible = unlocked.slice(0, 18);
  const lines = visible.map(row => {
    const member = safeText(row.member).slice(0, 50);
    const title = safeText(row.milestone_title).slice(0, 60);
    const value = Number(row.milestone_value || 0).toLocaleString('en-US');
    const unit = row.milestone_key === 'season_gain' ? ' rep'
      : row.milestone_key === 'active_days' ? ' active days'
        : ' consecutive days';
    return '**' + member + '** — 🏅 ' + title + ' · **' + value + unit + '**';
  });
  if (unlocked.length > visible.length) {
    lines.push('+' + (unlocked.length - visible.length) + ' additional unlocks · see the live achievements page');
  }

  const description = lines.length
    ? lines.join('\n')
    : 'A major season milestone was unlocked. Open the live achievements page for details.';
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      color: 0xf5c542,
      title: '🏅 Season ' + season + ' milestone unlocks!',
      description: description.slice(0, 3900),
      footer: {
        text: unlocked.length + ' major milestone unlock' + (unlocked.length === 1 ? '' : 's') +
          ' · Bleed Watch · Asia/Manila',
      },
      timestamp: new Date(Number(payload.poll_at || alert.created_at || Date.now())).toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'View Live Achievements',
        url: SITE + '/milestones.html',
      }],
    }],
    // A claimed outbox row has a stable ID; retries reuse the same Discord nonce.
    nonce: 'cm-' + String(alert.id).slice(-20),
    enforce_nonce: true,
  };
}

export async function dispatchChaosMilestoneAlert() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }
  if (!HAS_BOT && !HAS_WEBHOOK) {
    return { status: 'not_configured', reason: 'Discord bot/channel or webhook is not configured' };
  }

  const claimResponse = await fetch(REST + '/rpc/claim_chaos_milestone_alert', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now(), p_lease_ms: LEASE_MS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!claimResponse.ok) {
    const detail = (await claimResponse.text()).slice(0, 350);
    throw new Error('Milestone alert claim failed: HTTP ' + claimResponse.status +
      (detail ? ' · ' + detail : ''));
  }

  const claimed = await claimResponse.json();
  const alert = Array.isArray(claimed) ? claimed[0] : null;
  if (!alert) return { status: 'idle' };

  try {
    const messageId = await deliver(makeMilestoneDiscordPayload(alert));
    const sentAt = Date.now();
    const marked = await updateMilestoneClaim(alert, {
      status: 'sent',
      discord_message_id: messageId,
      sent_at: sentAt,
      lease_until: 0,
      last_error: null,
      updated_at: sentAt,
    });
    if (!marked) {
      console.error('Milestone alert delivered but outbox status was not confirmed', alert.id);
      return { status: 'sent_unconfirmed', alert_id: Number(alert.id) };
    }
    return {
      status: 'sent',
      alert_id: Number(alert.id),
      season_number: Number(alert.season_number),
      milestones: Array.isArray(alert.payload && alert.payload.unlocked)
        ? alert.payload.unlocked.length : 0,
      message_id: messageId,
      attempt_count: Number(alert.attempt_count),
    };
  } catch (error) {
    const attempt = Math.max(1, Number(alert.attempt_count) || 1);
    const backoff = Math.min(4 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));
    const failureAt = Date.now();
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    try {
      await updateMilestoneClaim(alert, {
        status: 'failed',
        next_attempt_at: failureAt + backoff,
        lease_until: 0,
        last_error: message,
        updated_at: failureAt,
      });
    } catch (updateError) {
      console.error('Could not schedule milestone alert retry:',
        String(updateError.message || updateError).slice(0, 300));
    }
    console.error('Milestone Discord alert failed:', message);
    return {
      status: 'retry_scheduled',
      alert_id: Number(alert.id),
      season_number: Number(alert.season_number),
      attempt_count: attempt,
      retry_after_ms: backoff,
    };
  }
}


async function updatePersonalBestClaim(alert, patch) {
  const query = new URLSearchParams({
    id: 'eq.' + alert.id,
    status: 'eq.sending',
    attempt_count: 'eq.' + alert.attempt_count,
  });
  const response = await fetch(REST + '/chaos_personal_best_alerts?' + query.toString(), {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    throw new Error('Personal best alert status update failed: HTTP ' + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length === 1;
}

function makePersonalBestDiscordPayload(alert) {
  const payload = alert.payload && typeof alert.payload === 'object' ? alert.payload : {};
  const season = Number(payload.season_number || alert.season_number);
  const day = String(payload.alert_day || '');
  const unlocked = Array.isArray(payload.unlocked) ? payload.unlocked : [];
  const visible = unlocked.slice(0, 16);
  const units = {
    season_gain: ' rep',
    active_days: ' days',
    longest_streak: ' days',
    gain_events: ' recorded increases',
    best_day_gain: ' rep in one day',
    best_week_gain: ' rep in one week',
  };
  const lines = visible.map(row => {
    const member = safeText(row.member).slice(0, 48);
    const title = safeText(row.record_title).slice(0, 48);
    const current = Number(row.record_value || 0).toLocaleString('en-US');
    const previous = Number(row.previous_value || 0).toLocaleString('en-US');
    const unit = units[row.record_key] || '';
    return '**' + member + '** · 🏆 ' + title + ' · **' + current + unit +
      '** (previous best ' + previous + ')';
  });
  if (unlocked.length > visible.length) {
    lines.push('+' + (unlocked.length - visible.length) + ' additional personal bests · see Records');
  }

  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      color: 0xf5c542,
      title: '🏆 New Chaos personal bests · Season ' + season,
      description: (lines.join('\n') || 'A new personal record was recorded.') .slice(0, 3900),
      footer: {
        text: unlocked.length + ' new personal best' + (unlocked.length === 1 ? '' : 's') +
          ' · one digest per Manila day',
      },
      timestamp: new Date((Number(alert.created_at) || Date.now())).toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'View All-Time Records',
        url: SITE + '/records.html',
      }, {
        type: 2,
        style: 5,
        label: 'Season ' + season,
        url: SITE + '/seasons.html?season=' + encodeURIComponent(season),
      }],
    }],
    // One daily outbox row gets one stable nonce across delivery retries.
    nonce: 'pb-' + String(alert.id).slice(-20),
    enforce_nonce: true,
  };
}

export async function dispatchChaosPersonalBestAlert() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }
  if (!HAS_BOT && !HAS_WEBHOOK) {
    return { status: 'not_configured', reason: 'Discord bot/channel or webhook is not configured' };
  }

  const claimResponse = await fetch(REST + '/rpc/claim_chaos_personal_best_alert', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now(), p_lease_ms: LEASE_MS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!claimResponse.ok) {
    const detail = (await claimResponse.text()).slice(0, 350);
    throw new Error('Personal best alert claim failed: HTTP ' + claimResponse.status +
      (detail ? ' · ' + detail : ''));
  }

  const claimed = await claimResponse.json();
  const alert = Array.isArray(claimed) ? claimed[0] : null;
  if (!alert) return { status: 'idle' };

  try {
    const messageId = await deliver(makePersonalBestDiscordPayload(alert));
    const sentAt = Date.now();
    const marked = await updatePersonalBestClaim(alert, {
      status: 'sent',
      discord_message_id: messageId,
      sent_at: sentAt,
      lease_until: 0,
      last_error: null,
      updated_at: sentAt,
    });
    if (!marked) {
      console.error('Personal best digest delivered but outbox status was not confirmed', alert.id);
      return { status: 'sent_unconfirmed', alert_id: Number(alert.id) };
    }
    return {
      status: 'sent',
      alert_id: Number(alert.id),
      season_number: Number(alert.season_number),
      record_count: Array.isArray(alert.payload && alert.payload.unlocked)
        ? alert.payload.unlocked.length : 0,
      message_id: messageId,
      attempt_count: Number(alert.attempt_count),
    };
  } catch (error) {
    const attempt = Math.max(1, Number(alert.attempt_count) || 1);
    const backoff = Math.min(4 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));
    const failureAt = Date.now();
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    try {
      await updatePersonalBestClaim(alert, {
        status: 'failed',
        next_attempt_at: failureAt + backoff,
        lease_until: 0,
        last_error: message,
        updated_at: failureAt,
      });
    } catch (updateError) {
      console.error('Could not schedule personal best retry:',
        String(updateError.message || updateError).slice(0, 300));
    }
    console.error('Personal best Discord digest failed:', message);
    return {
      status: 'retry_scheduled',
      alert_id: Number(alert.id),
      season_number: Number(alert.season_number),
      attempt_count: attempt,
      retry_after_ms: backoff,
    };
  }
}


// ---------- Weekly season report ----------
// The queue function only creates a report after a complete Monday-Sunday
// window has seven saved daily ranking snapshots. Its unique season/week key
// makes repeated minute-scheduler calls safe.
export async function queueChaosWeeklySeasonReport() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }

  const response = await fetch(REST + '/rpc/queue_chaos_weekly_season_report', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now() }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    throw new Error('Weekly season report queue failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  const result = await response.json();
  return result && typeof result === 'object' ? result : { status: 'unknown' };
}

async function updateWeeklySeasonReportClaim(report, patch) {
  const query = new URLSearchParams({
    id: 'eq.' + report.id,
    status: 'eq.sending',
    attempt_count: 'eq.' + report.attempt_count,
  });
  const response = await fetch(REST + '/chaos_weekly_season_reports?' + query.toString(), {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    throw new Error('Weekly season report status update failed: HTTP ' + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length === 1;
}

function makeWeeklySeasonReportDiscordPayload(report) {
  const payload = report.payload && typeof report.payload === 'object' ? report.payload : {};
  const season = Number(payload.season_number || report.season_number);
  const start = String(payload.week_start || report.week_start || '');
  const end = String(payload.week_end || report.week_end || '');
  const gain = Number(payload.total_gain || 0).toLocaleString('en-US');
  const events = Number(payload.total_events || 0).toLocaleString('en-US');
  const activeMembers = Number(payload.active_members || 0).toLocaleString('en-US');
  const trackedDays = Number(payload.tracked_days || 0);
  const topGainers = Array.isArray(payload.top_gainers) ? payload.top_gainers.slice(0, 5) : [];
  const mostActive = Array.isArray(payload.most_active) ? payload.most_active.slice(0, 5) : [];
  const improvements = Array.isArray(payload.biggest_improvements)
    ? payload.biggest_improvements.slice(0, 5) : [];
  const personalRecords = Array.isArray(payload.personal_records)
    ? payload.personal_records.slice(0, 8) : [];

  const lines = (rows, render, empty) => rows.length
    ? rows.map((row, index) => render(row, index)).join('\n')
    : empty;

  const topLines = lines(topGainers, (row, index) =>
    '**' + (index + 1) + '.** ' + safeText(row.member).slice(0, 48) +
    ' · **+' + Number(row.gain || 0).toLocaleString('en-US') + ' rep**',
  'No recorded reputation gains this week.');

  const activeLines = lines(mostActive, (row, index) =>
    '**' + (index + 1) + '.** ' + safeText(row.member).slice(0, 48) +
    ' · **' + Number(row.active_days || 0).toLocaleString('en-US') + ' days** · +' +
    Number(row.gain || 0).toLocaleString('en-US') + ' rep',
  'No active members were recorded this week.');

  const improvementLines = payload.improvements_available
    ? lines(improvements, row =>
        '**' + safeText(row.member).slice(0, 48) + '** · +' +
        Number(row.improvement || 0).toLocaleString('en-US') + ' rep (' +
        Number(row.current_gain || 0).toLocaleString('en-US') + ' vs ' +
        Number(row.previous_gain || 0).toLocaleString('en-US') + ')',
      'No positive week-over-week improvements.')
    : 'A complete previous week was not available for comparison.';

  const recordLines = lines(personalRecords, row =>
    '**' + safeText(row.member).slice(0, 42) + '** · ' +
    safeText(row.record_title).slice(0, 52) + ' · **' +
    Number(row.record_value || 0).toLocaleString('en-US') + '**',
  'No new personal records this week.');

  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      color: 0xf5c542,
      title: '📊 Chaos Weekly Report · Season ' + season,
      description: '**' + start + ' – ' + end + '** · Manila calendar week',
      fields: [
        {
          name: '📈 Weekly totals',
          value: '**+' + gain + ' rep**\n' + events + ' recorded increases',
          inline: true,
        },
        {
          name: '👥 Activity coverage',
          value: '**' + activeMembers + ' members**\n' + trackedDays + '/7 days tracked',
          inline: true,
        },
        { name: '🥇 Top reputation gainers', value: topLines, inline: false },
        { name: '🔥 Most active members', value: activeLines, inline: false },
        { name: '📊 Biggest improvements', value: improvementLines, inline: false },
        { name: '🏆 New personal records', value: recordLines, inline: false },
      ],
      footer: { text: 'Bleed Watch · weekly report · Asia/Manila' },
      timestamp: new Date(Number(payload.generated_at || report.created_at || Date.now())).toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'Open Season Analytics',
        url: SITE + '/analytics.html?season=' + encodeURIComponent(season),
      }, {
        type: 2,
        style: 5,
        label: 'Season Leaderboard',
        url: SITE + '/seasons.html?season=' + encodeURIComponent(season),
      }],
    }],
    // The season and week key stays stable across delivery retries.
    nonce: 'wr-' + season + '-' + start,
    enforce_nonce: true,
  };
}

export async function dispatchChaosWeeklySeasonReport() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }
  if (!HAS_BOT && !HAS_WEBHOOK) {
    return { status: 'not_configured', reason: 'Discord bot/channel or webhook is not configured' };
  }

  const claimResponse = await fetch(REST + '/rpc/claim_chaos_weekly_season_report', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now(), p_lease_ms: LEASE_MS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!claimResponse.ok) {
    const detail = (await claimResponse.text()).slice(0, 350);
    throw new Error('Weekly season report claim failed: HTTP ' + claimResponse.status +
      (detail ? ' · ' + detail : ''));
  }

  const claimed = await claimResponse.json();
  const report = Array.isArray(claimed) ? claimed[0] : null;
  if (!report) return { status: 'idle' };

  try {
    const messageId = await deliver(makeWeeklySeasonReportDiscordPayload(report));
    const sentAt = Date.now();
    const marked = await updateWeeklySeasonReportClaim(report, {
      status: 'sent',
      discord_message_id: messageId,
      sent_at: sentAt,
      lease_until: 0,
      last_error: null,
      updated_at: sentAt,
    });
    if (!marked) {
      console.error('Weekly season report delivered but outbox status was not confirmed', report.id);
      return { status: 'sent_unconfirmed', report_id: Number(report.id) };
    }
    return {
      status: 'sent',
      report_id: Number(report.id),
      season_number: Number(report.season_number),
      week_start: String(report.week_start),
      week_end: String(report.week_end),
      message_id: messageId,
      attempt_count: Number(report.attempt_count),
    };
  } catch (error) {
    const attempt = Math.max(1, Number(report.attempt_count) || 1);
    const backoff = Math.min(4 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));
    const failureAt = Date.now();
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    try {
      await updateWeeklySeasonReportClaim(report, {
        status: 'failed',
        next_attempt_at: failureAt + backoff,
        lease_until: 0,
        last_error: message,
        updated_at: failureAt,
      });
    } catch (updateError) {
      console.error('Could not schedule weekly season report retry:',
        String(updateError.message || updateError).slice(0, 300));
    }
    console.error('Weekly season report Discord delivery failed:', message);
    return {
      status: 'retry_scheduled',
      report_id: Number(report.id),
      season_number: Number(report.season_number),
      attempt_count: attempt,
      retry_after_ms: backoff,
    };
  }
}


// ---------- Live Season Awards Race alerts ----------
// The snapshot is compared and queued transactionally by Supabase. The first
// healthy read seeds state without announcing the existing leader as "new".
const AWARD_RACE_MAX_STATS_AGE_MS = 10 * 60 * 1000;

async function readAwardRaceJson(path, label) {
  const response = await fetch(REST + path, {
    headers: H,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 250);
    throw new Error(label + ' read failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  return response.json();
}

function awardRaceElapsedDays(season, now) {
  const start = Number(season && season.started_at);
  const end = season && season.ended_at != null ? Number(season.ended_at) : now;
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end)) return null;
  return Math.max(1, (end - start) / 86400000);
}

function awardRaceLeaders(title, unit, rows, getValue) {
  const candidates = rows.map(row => ({
    member: String(row.member || ''),
    value: Number(getValue(row) || 0),
  })).filter(row => row.member && Number.isFinite(row.value) && row.value > 0)
    .sort((a, b) => b.value - a.value || a.member.localeCompare(b.member));

  if (!candidates.length) {
    return { title, unit, available: false, leaders: [], winning_value: null };
  }

  const best = candidates[0].value;
  return {
    title,
    unit,
    available: true,
    leaders: candidates.filter(row => Math.abs(row.value - best) < 0.0000001)
      .map(row => row.member).sort(),
    winning_value: best,
  };
}

function buildAwardRaceSnapshot(season, previousSeason, currentRows, previousRows, now) {
  const awards = {
    season_mvp: awardRaceLeaders('Season MVP', 'rep', currentRows, row => row.season_gain),
    most_active: awardRaceLeaders('Most Active', 'days', currentRows, row => row.active_days),
    consistency: awardRaceLeaders('Consistency Award', 'days', currentRows, row => row.longest_streak_days),
    most_recorded_increases: awardRaceLeaders(
      'Most Recorded Increases', 'recorded increases', currentRows, row => row.gain_events
    ),
  };

  if (previousSeason) {
    const currentDays = awardRaceElapsedDays(season, now);
    const previousDays = awardRaceElapsedDays(previousSeason, now);
    const previousByMember = new Map(previousRows.map(row => [String(row.member), row]));
    const improvements = currentDays && previousDays
      ? currentRows.map(row => {
          const previous = previousByMember.get(String(row.member));
          if (!previous || Number(row.season_gain || 0) <= 0 ||
              Number(previous.season_gain || 0) <= 0) return null;
          const value = Math.round((
            Number(row.season_gain || 0) / currentDays -
            Number(previous.season_gain || 0) / previousDays
          ) * 1000) / 1000;
          return value > 0 ? { member: row.member, value } : null;
        }).filter(Boolean)
      : [];
    awards.most_improved = awardRaceLeaders(
      'Most Improved', 'rep/day', improvements, row => row.value
    );

    const previousMembers = new Set(previousRows.map(row => String(row.member)));
    const rookies = currentRows.filter(row =>
      Number(row.season_gain || 0) > 0 && !previousMembers.has(String(row.member))
    );
    awards.rookie_of_season = awardRaceLeaders(
      'Rookie of the Season', 'rep', rookies, row => row.season_gain
    );
  } else {
    awards.most_improved = {
      title: 'Most Improved', unit: 'rep/day', available: false, leaders: [], winning_value: null,
    };
    awards.rookie_of_season = {
      title: 'Rookie of the Season', unit: 'rep', available: false, leaders: [], winning_value: null,
    };
  }

  return {
    season_number: Number(season.season_number),
    observed_at: now,
    awards,
  };
}

export async function queueChaosAwardRaceAlert() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }

  const seasonsQuery = new URLSearchParams({
    select: 'season_number,started_at,ended_at,status',
    order: 'season_number.desc',
    limit: '100',
  });
  const seasons = await readAwardRaceJson(
    '/chaos_seasons?' + seasonsQuery.toString(), 'Award race season history'
  );
  const seasonList = Array.isArray(seasons) ? seasons : [];
  const active = seasonList.find(row => row.status === 'active');
  if (!active) return { status: 'no_active_season' };

  const previous = seasonList.filter(row =>
    Number(row.season_number) < Number(active.season_number)
  ).sort((a, b) => Number(b.season_number) - Number(a.season_number))[0] || null;

  const statsQuery = new URLSearchParams({
    select: 'season_number,member,season_gain,gain_events,active_days,longest_streak_days,updated_at',
    season_number: 'eq.' + Number(active.season_number),
    order: 'member.asc',
    limit: '1000',
  });
  const currentRowsRaw = await readAwardRaceJson(
    '/chaos_season_member_stats?' + statsQuery.toString(), 'Current award race standings'
  );
  const currentRows = Array.isArray(currentRowsRaw) ? currentRowsRaw : [];
  if (!currentRows.length) return { status: 'no_member_stats' };

  const latestStatsAt = currentRows.reduce((latest, row) =>
    Math.max(latest, Number(row.updated_at || 0)), 0);
  const now = Date.now();
  if (!latestStatsAt || now - latestStatsAt > AWARD_RACE_MAX_STATS_AGE_MS) {
    return {
      status: 'stale_stats',
      season_number: Number(active.season_number),
      latest_stats_at: latestStatsAt || null,
    };
  }

  let previousRows = [];
  if (previous) {
    const previousQuery = new URLSearchParams({
      select: 'season_number,member,season_gain',
      season_number: 'eq.' + Number(previous.season_number),
      order: 'member.asc',
      limit: '1000',
    });
    const previousRaw = await readAwardRaceJson(
      '/chaos_season_member_stats?' + previousQuery.toString(), 'Previous award race standings'
    );
    previousRows = Array.isArray(previousRaw) ? previousRaw : [];
  }

  const snapshot = buildAwardRaceSnapshot(active, previous, currentRows, previousRows, now);
  const response = await fetch(REST + '/rpc/record_chaos_award_race_snapshot', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      p_season_number: Number(active.season_number),
      p_snapshot: snapshot,
      p_now: now,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    throw new Error('Award race snapshot failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  const result = await response.json();
  return result && typeof result === 'object' ? result : { status: 'unknown' };
}

async function updateAwardRaceClaim(alert, patch) {
  const query = new URLSearchParams({
    id: 'eq.' + alert.id,
    status: 'eq.sending',
    attempt_count: 'eq.' + alert.attempt_count,
  });
  const response = await fetch(REST + '/chaos_award_race_alerts?' + query.toString(), {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    throw new Error('Award race alert status update failed: HTTP ' + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length === 1;
}

function makeAwardRaceDiscordPayload(alert) {
  const payload = alert.payload && typeof alert.payload === 'object' ? alert.payload : {};
  const season = Number(payload.season_number || alert.season_number);
  const events = Array.isArray(payload.events) ? payload.events.slice(0, 6) : [];
  const formatValue = (value, unit) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return number.toLocaleString('en-US', {
      maximumFractionDigits: 3,
      minimumFractionDigits: unit === 'rep/day' ? 3 : 0,
    }) + (unit ? ' ' + unit : '');
  };
  const names = rows => {
    const all = (Array.isArray(rows) ? rows : [])
      .map(name => safeText(name).slice(0, 45));
    const visible = all.slice(0, 8).join(', ');
    return all.length > 8 ? visible + ' +' + (all.length - 8) + ' more' : visible;
  };
  const fields = events.map(event => {
    const current = names(event.current_leaders);
    const gained = names(event.gained_leaders);
    const lost = names(event.lost_leaders);
    const title = safeText(event.award_title || event.award_key || 'Season award').slice(0, 100);
    let headline;
    if (event.event_type === 'tied_for_first') {
      headline = '🤝 **Tied for first:** ' + current;
    } else if (event.event_type === 'tie_broken') {
      headline = '⚡ **Tie broken — outright leader:** ' + current;
    } else if (event.event_type === 'tie_changed') {
      headline = '🔄 **First-place tie changed:** ' + current;
    } else {
      headline = '🥇 **New leader:** ' + current;
    }

    const lines = [headline];
    if (gained && event.event_type !== 'lead_change') {
      lines.push('Joined first place: ' + gained);
    }
    if (lost) {
      lines.push('No longer first: ' + lost);
    }
    lines.push('Leading score: **' +
      formatValue(event.winning_value, String(event.unit || '')) + '**');
    return { name: title, value: lines.join('\n').slice(0, 1024), inline: false };
  });

  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      color: 0xf5c542,
      title: '🏁 Live Season ' + season + ' award race changes',
      description: events.length
        ? 'The provisional first-place standings changed. These are live standings, not final trophies.'
        : 'The live award race was updated.',
      fields,
      footer: { text: 'Bleed Watch · provisional awards · Asia/Manila' },
      timestamp: new Date(Number(payload.generated_at || alert.created_at || Date.now())).toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'View Live Awards Race',
        url: SITE + '/awards-race.html',
      }, {
        type: 2,
        style: 5,
        label: 'Season Leaderboard',
        url: SITE + '/seasons.html?season=' + encodeURIComponent(season),
      }],
    }],
    // Reusing the alert ID prevents a timed-out retry from duplicating the Discord message.
    nonce: 'ar-' + String(alert.id),
    enforce_nonce: true,
  };
}

export async function dispatchChaosAwardRaceAlert() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }
  if (!HAS_BOT && !HAS_WEBHOOK) {
    return { status: 'not_configured', reason: 'Discord bot/channel or webhook is not configured' };
  }

  const claimResponse = await fetch(REST + '/rpc/claim_chaos_award_race_alert', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now(), p_lease_ms: LEASE_MS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!claimResponse.ok) {
    const detail = (await claimResponse.text()).slice(0, 350);
    throw new Error('Award race alert claim failed: HTTP ' + claimResponse.status +
      (detail ? ' · ' + detail : ''));
  }

  const claimed = await claimResponse.json();
  const alert = Array.isArray(claimed) ? claimed[0] : null;
  if (!alert) return { status: 'idle' };

  try {
    const messageId = await deliver(makeAwardRaceDiscordPayload(alert));
    const sentAt = Date.now();
    const marked = await updateAwardRaceClaim(alert, {
      status: 'sent',
      discord_message_id: messageId,
      sent_at: sentAt,
      lease_until: 0,
      last_error: null,
      updated_at: sentAt,
    });
    if (!marked) {
      console.error('Award race alert delivered but outbox status was not confirmed', alert.id);
      return { status: 'sent_unconfirmed', alert_id: Number(alert.id) };
    }
    return {
      status: 'sent',
      alert_id: Number(alert.id),
      season_number: Number(alert.season_number),
      events: Array.isArray(alert.payload && alert.payload.events)
        ? alert.payload.events.length : 0,
      message_id: messageId,
      attempt_count: Number(alert.attempt_count),
    };
  } catch (error) {
    const attempt = Math.max(1, Number(alert.attempt_count) || 1);
    const backoff = Math.min(4 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));
    const failureAt = Date.now();
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    try {
      await updateAwardRaceClaim(alert, {
        status: 'failed',
        next_attempt_at: failureAt + backoff,
        lease_until: 0,
        last_error: message,
        updated_at: failureAt,
      });
    } catch (updateError) {
      console.error('Could not schedule award race alert retry:',
        String(updateError.message || updateError).slice(0, 300));
    }
    console.error('Season award race Discord alert failed:', message);
    return {
      status: 'retry_scheduled',
      alert_id: Number(alert.id),
      season_number: Number(alert.season_number),
      attempt_count: attempt,
      retry_after_ms: backoff,
    };
  }
}


// Member retention alerts use the active-season ledger. A member is queued
// once on first crossing 7 quiet days and once again on crossing 14 days.
function retentionAlertManilaDay(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

function retentionAlertDayDiff(from, to) {
  const a = new Date(String(from).slice(0, 10) + 'T00:00:00Z').getTime();
  const b = new Date(String(to).slice(0, 10) + 'T00:00:00Z').getTime();
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.max(0, Math.floor((b - a) / 86400000)) : 0;
}

export async function queueChaosMemberRetentionAlerts() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }

  const now = Date.now();
  const seasons = await readAwardRaceJson(
    '/chaos_seasons?select=season_number,started_at,status&order=season_number.desc&limit=100',
    'Member retention season history'
  );
  const seasonList = Array.isArray(seasons) ? seasons : [];
  const active = seasonList.find(row => row.status === 'active');
  if (!active) return { status: 'no_active_season' };

  const seasonNumber = Number(active.season_number);
  const query = new URLSearchParams({
    select: 'member,last_gain_at,last_gain_day,updated_at',
    season_number: 'eq.' + seasonNumber,
    order: 'member.asc',
    limit: '1000',
  });
  const raw = await readAwardRaceJson(
    '/chaos_season_member_stats?' + query.toString(),
    'Member retention statistics'
  );
  const rows = Array.isArray(raw) ? raw : [];
  if (!rows.length) return { status: 'no_member_stats' };

  const latestStatsAt = rows.reduce((latest, row) =>
    Math.max(latest, Number(row.updated_at || 0)), 0);
  if (!latestStatsAt || now - latestStatsAt > 10 * 60 * 1000) {
    return { status: 'stale_stats', season_number: seasonNumber, latest_stats_at: latestStatsAt || null };
  }

  const today = retentionAlertManilaDay(now);
  const seasonStartDay = retentionAlertManilaDay(active.started_at);
  const pending = [];
  for (const row of rows) {
    const name = String(row.member || '').trim();
    if (!name) continue;
    const lastGainAt = row.last_gain_at == null ? null : Number(row.last_gain_at);
    const referenceDay = row.last_gain_day
      ? String(row.last_gain_day).slice(0, 10)
      : retentionAlertManilaDay(lastGainAt) || seasonStartDay;
    if (!referenceDay) continue;
    const inactivityDays = retentionAlertDayDiff(referenceDay, today);
    if (inactivityDays < 7) continue;
    const thresholdDays = inactivityDays >= 14 ? 14 : 7;
    pending.push({
      season_number: seasonNumber,
      member: name,
      threshold_days: thresholdDays,
      last_gain_at: lastGainAt,
      inactivity_days: inactivityDays,
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: now,
      lease_until: 0,
      created_at: now,
      updated_at: now,
    });
  }

  if (!pending.length) return { status: 'idle', season_number: seasonNumber, eligible: 0 };
  const insertQuery = new URLSearchParams({
    on_conflict: 'season_number,member,threshold_days',
  });
  const response = await fetch(REST + '/chaos_member_retention_alerts?' + insertQuery.toString(), {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(pending),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    throw new Error('Member retention alert queue failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  const inserted = await response.json();
  const count = Array.isArray(inserted) ? inserted.length : 0;
  return {
    status: count ? 'queued' : 'idle',
    season_number: seasonNumber,
    eligible: pending.length,
    queued: count,
  };
}

async function updateMemberRetentionClaims(alerts, patch) {
  const ids = alerts.map(alert => Number(alert.id)).filter(Number.isSafeInteger);
  if (!ids.length) return false;
  const query = new URLSearchParams({
    id: 'in.(' + ids.join(',') + ')',
    status: 'eq.sending',
  });
  const response = await fetch(REST + '/chaos_member_retention_alerts?' + query.toString(), {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) throw new Error('Member retention alert status update failed: HTTP ' + response.status);
  const rows = await response.json();
  return Array.isArray(rows) && rows.length === ids.length;
}

function makeMemberRetentionDiscordPayload(alerts) {
  const season = Number(alerts[0] && alerts[0].season_number || 0);
  const fourteen = alerts.filter(row => Number(row.threshold_days) >= 14);
  const seven = alerts.filter(row => Number(row.threshold_days) < 14);
  const lines = rows => {
    const visible = rows.slice(0, 16).map(row =>
      '• **' + safeText(row.member).slice(0, 48) + '** · ' +
      Number(row.inactivity_days || row.threshold_days).toLocaleString('en-US') + ' days'
    );
    if (rows.length > visible.length) {
      visible.push('+' + (rows.length - visible.length) + ' more members · open the retention dashboard');
    }
    return visible.length ? visible.join('\n') : 'None';
  };
  const fields = [];
  if (fourteen.length) {
    fields.push({
      name: '🔴 14+ days without a recorded gain · ' + fourteen.length,
      value: lines(fourteen).slice(0, 1024),
      inline: false,
    });
  }
  if (seven.length) {
    fields.push({
      name: '🟡 7–13 days without a recorded gain · ' + seven.length,
      value: lines(seven).slice(0, 1024),
      inline: false,
    });
  }
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      color: fourteen.length ? 0xff6975 : 0xf5c542,
      title: '🧭 Member retention watch · Season ' + season,
      description: 'These members have crossed an inactivity threshold based on their last recorded positive reputation gain. This is a grouped digest, not a live online-status check.',
      fields,
      footer: { text: 'Bleed Watch · retention thresholds · Asia/Manila' },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'Open Member Retention',
        url: SITE + '/retention.html',
      }, {
        type: 2,
        style: 5,
        label: 'Member Activity',
        url: SITE + '/activity.html',
      }],
    }],
    // The same claimed batch reuses this nonce on a delivery retry.
    nonce: 'mr-' + String(alerts[0].id).slice(-9) + '-' +
      String(alerts[alerts.length - 1].id).slice(-9),
    enforce_nonce: true,
  };
}

export async function dispatchChaosMemberRetentionAlerts() {
  if (!SUPABASE_URL || !KEY) {
    return { status: 'not_configured', reason: 'Supabase server credentials are missing' };
  }
  if (!HAS_BOT && !HAS_WEBHOOK) {
    return { status: 'not_configured', reason: 'Discord bot/channel or webhook is not configured' };
  }

  const claimResponse = await fetch(REST + '/rpc/claim_chaos_member_retention_alerts', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now(), p_limit: 30, p_lease_ms: LEASE_MS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!claimResponse.ok) {
    const detail = (await claimResponse.text()).slice(0, 350);
    throw new Error('Member retention alert claim failed: HTTP ' + claimResponse.status +
      (detail ? ' · ' + detail : ''));
  }
  const claimed = await claimResponse.json();
  const alerts = Array.isArray(claimed) ? claimed : [];
  if (!alerts.length) return { status: 'idle' };

  try {
    const messageId = await deliver(makeMemberRetentionDiscordPayload(alerts));
    const sentAt = Date.now();
    const marked = await updateMemberRetentionClaims(alerts, {
      status: 'sent',
      discord_message_id: messageId,
      sent_at: sentAt,
      lease_until: 0,
      last_error: null,
      updated_at: sentAt,
    });
    if (!marked) {
      console.error('Member retention digest delivered but outbox status was not confirmed',
        alerts.map(row => row.id));
      return { status: 'sent_unconfirmed', alerts: alerts.length };
    }
    return {
      status: 'sent',
      season_number: Number(alerts[0].season_number),
      alerts: alerts.length,
      members: new Set(alerts.map(row => row.member)).size,
      message_id: messageId,
      attempt_count: Math.max(...alerts.map(row => Number(row.attempt_count) || 1)),
    };
  } catch (error) {
    const attempt = Math.max(1, ...alerts.map(row => Number(row.attempt_count) || 1));
    const backoff = Math.min(4 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));
    const failureAt = Date.now();
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    try {
      await updateMemberRetentionClaims(alerts, {
        status: 'failed',
        next_attempt_at: failureAt + backoff,
        lease_until: 0,
        last_error: message,
        updated_at: failureAt,
      });
    } catch (updateError) {
      console.error('Could not schedule member retention alert retry:',
        String(updateError.message || updateError).slice(0, 300));
    }
    console.error('Member retention Discord digest failed:', message);
    return {
      status: 'retry_scheduled',
      alerts: alerts.length,
      attempt_count: attempt,
      retry_after_ms: backoff,
    };
  }
}


// ---------- Clan Health score and Discord risk / weekly alerts ----------

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
  if (!HAS_BOT && !HAS_WEBHOOK) return { status: 'not_configured', reason: 'Discord is not configured' };

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


// ---------- Clan Rivalry rank defense alerts ----------

export async function queueChaosClanRivalryAlerts(clans, snapshotAt) {
  if (!SUPABASE_URL || !KEY) return { status: 'not_configured' };
  if (!Array.isArray(clans) || !clans.length) return { status: 'no_snapshot' };

  const ranked = clans
    .filter(clan => clan && clan.name && Number.isSafeInteger(Number(clan.rank)) &&
      Number(clan.rank) > 0 && Number.isSafeInteger(Number(clan.rep)) && Number(clan.rep) >= 0)
    .map(clan => ({ name: String(clan.name), rank: Number(clan.rank), rep: Number(clan.rep) }))
    .sort((a, b) => a.rank - b.rank);
  if (!ranked.length) return { status: 'no_snapshot' };

  const chaosIndex = ranked.findIndex(clan => clan.name.toLowerCase() === 'chaos');
  if (chaosIndex < 0) return { status: 'chaos_not_ranked', clan_count: ranked.length };

  const chaos = ranked[chaosIndex];
  const threat = ranked[chaosIndex + 1] || null;
  const activeSeasonResponse = await fetch(
    REST + '/chaos_seasons?select=season_number&status=eq.active&order=season_number.desc&limit=1',
    { headers: H, signal: AbortSignal.timeout(TIMEOUT) }
  );
  if (!activeSeasonResponse.ok) {
    throw new Error('Clan rivalry active-season lookup failed: HTTP ' + activeSeasonResponse.status);
  }
  const seasons = await activeSeasonResponse.json();
  const seasonNumber = Array.isArray(seasons) && seasons[0]
    ? Number(seasons[0].season_number) : 0;
  if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 1) {
    return { status: 'no_active_season' };
  }

  const sampleTimestamp = Number(snapshotAt) || Date.now();
  const sampleCandidates = ranked.filter((clan, index) =>
    clan.rank <= 10 || Math.abs(index - chaosIndex) <= 2
  ).slice(0, 20);
  let momentumSample = { status: 'skipped' };
  try {
    const sampleResponse = await fetch(REST + '/rpc/record_chaos_clan_rivalry_samples', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        p_season_number: seasonNumber,
        p_sample_at: sampleTimestamp,
        p_clans: sampleCandidates,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!sampleResponse.ok) {
      const detail = (await sampleResponse.text()).slice(0, 300);
      throw new Error('Clan momentum sample write failed: HTTP ' + sampleResponse.status +
        (detail ? ' · ' + detail : ''));
    }
    momentumSample = await sampleResponse.json();
  } catch (sampleError) {
    console.error('Clan momentum sampling failed:', String(sampleError && sampleError.message || sampleError).slice(0, 300));
    momentumSample = { status: 'error' };
  }

  const payload = {
    p_season_number: seasonNumber,
    p_rank: chaos.rank,
    p_rep: chaos.rep,
    p_threat_clan: threat ? threat.name : null,
    p_threat_gap: threat ? chaos.rep - threat.rep : null,
    p_clans: ranked,
    p_snapshot_at: Number(snapshotAt) || Date.now(),
  };
  const response = await fetch(REST + '/rpc/process_chaos_clan_rivalry_snapshot', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    throw new Error('Clan rivalry snapshot processing failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  const processed = await response.json();
  let momentum = null;
  let forecastAlert = null;
  try {
    momentum = await getClanMomentumForecast(seasonNumber, sampleTimestamp);
    if (momentum.status !== 'stale' && momentum.coverage &&
        momentum.coverage.all_rivals_ready && Array.isArray(momentum.rival_forecasts)) {
      const forecastResponse = await fetch(REST + '/rpc/process_chaos_clan_rivalry_forecast_alerts', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          p_season_number: seasonNumber,
          p_forecasts: momentum.rival_forecasts,
          p_snapshot_at: momentum.latest_sample_at,
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!forecastResponse.ok) {
        const detail = (await forecastResponse.text()).slice(0, 300);
        throw new Error('Multi-rival momentum alert processing failed: HTTP ' + forecastResponse.status +
          (detail ? ' · ' + detail : ''));
      }
      forecastAlert = await forecastResponse.json();
    }
  } catch (forecastError) {
    console.error('Clan momentum forecast processing failed:',
      String(forecastError && forecastError.message || forecastError).slice(0, 350));
  }

  return {
    ...(processed && typeof processed === 'object' ? processed : {}),
    momentum_sample: momentumSample.status,
    momentum_status: momentum ? momentum.status : 'unavailable',
    forecast_alert: forecastAlert,
  };
}

async function finishClanRivalryAlert(alert, status, options = {}) {
  const response = await fetch(REST + '/rpc/finish_chaos_clan_rivalry_alert', {
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
    throw new Error('Clan rivalry alert completion failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  return response.json();
}

function makeClanRivalryEmbed(alert) {
  const p = alert.payload && typeof alert.payload === 'object' ? alert.payload : {};
  const season = Number(p.season_number || 0);
  const rank = Number(p.current_rank || 0);
  const rep = Number(p.chaos_rep || 0);
  const at = Number(p.snapshot_at || alert.created_at || Date.now());
  const fields = [];
  let color = 0xf5c542;
  let title = '📊 Chaos clan ranking update';
  let description = 'The latest clan ranking has been processed.';

  if (alert.event_type === 'rank_gain') {
    color = 0x3ecf8e;
    title = '🏆 Chaos climbed the clan rankings';
    description = 'Chaos moved from **#' + Number(p.previous_rank || 0) + '** to **#' +
      rank + '** in the live ranking.';
    const passed = Array.isArray(p.passed_clans) ? p.passed_clans.slice(0, 8) : [];
    fields.push({
      name: 'Clans overtaken',
      value: passed.length
        ? passed.map(row => '**#' + Number(row.rank || 0) + '** · ' + safeText(row.name)).join('\n').slice(0, 1024)
        : 'The rank improved, but no individual clan transition was available.',
      inline: false,
    });
  } else if (alert.event_type === 'rank_loss') {
    color = 0xff6975;
    title = '⚠️ Chaos lost a ranking position';
    description = 'Chaos moved from **#' + Number(p.previous_rank || 0) + '** to **#' +
      rank + '**. A rival moved ahead in the live ranking.';
    const passed = Array.isArray(p.passed_by) ? p.passed_by.slice(0, 8) : [];
    fields.push({
      name: 'Clans now ahead',
      value: passed.length
        ? passed.map(row => '**#' + Number(row.rank || 0) + '** · ' + safeText(row.name)).join('\n').slice(0, 1024)
        : 'The rank changed, but the overtaking clan could not be resolved.',
      inline: false,
    });
  } else if (alert.event_type === 'threat_warning') {
    const threshold = Number(p.threshold || 500);
    const gap = Number(p.gap || 0);
    color = threshold <= 100 ? 0xff4d5a : threshold <= 250 ? 0xff6975 : 0xf5c542;
    title = '🚨 A rival is closing in on Chaos';
    const gapLabel = gap > 0 ? gap.toLocaleString('en-US') + ' reputation behind Chaos'
      : gap === 0 ? 'tied with Chaos on reputation'
        : Math.abs(gap).toLocaleString('en-US') + ' reputation ahead of Chaos';
    description = '**' + safeText(p.rival_clan) + '** is ' + gapLabel +
      ' and has entered the **' + threshold.toLocaleString('en-US') +
      '-reputation warning zone**.';
    fields.push({
      name: 'Current position',
      value: 'Chaos **#' + rank + '** · **' + rep.toLocaleString('en-US') + ' rep**',
      inline: true,
    }, {
      name: 'Warning level',
      value: '**' + threshold.toLocaleString('en-US') + ' rep**',
      inline: true,
    });
  } else if (alert.event_type === 'momentum_warning' || alert.event_type === 'chase_warning') {
    const eta = Math.max(0, Number(p.eta_minutes || 0));
    const etaLabel = eta < 60 ? eta + ' minute(s)'
      : Math.floor(eta / 60) + 'h ' + (eta % 60) + 'm';
    const threshold = Number(p.threshold_minutes || 360);
    const pace = Number(p.relative_gain_per_hour || 0);
    const isChase = alert.event_type === 'chase_warning';
    color = threshold <= 60 ? 0xff4d5a : isChase ? 0x3ecf8e : 0xffa33e;
    if (isChase) {
      title = threshold <= 60
        ? '🏁 Chaos could gain a rank within an hour'
        : '🏁 Chaos has a rank-chasing opportunity';
      description = 'Chaos is gaining about **' +
        pace.toLocaleString('en-US', { maximumFractionDigits: 1 }) +
        ' more reputation per hour** than **' + safeText(p.defender_clan) +
        '**. At the observed six-hour pace, Chaos could overtake this rival in **' + etaLabel + '**.';
    } else {
      title = threshold <= 60
        ? '🚨 A rival could overtake Chaos within an hour'
        : '⚠️ A rival is closing in on Chaos';
      description = '**' + safeText(p.challenger_clan) + '** is gaining about **' +
        pace.toLocaleString('en-US', { maximumFractionDigits: 1 }) +
        ' more reputation per hour** than Chaos. At the observed six-hour pace, the estimated overtake window is **' +
        etaLabel + '**.';
    }
    fields.push({
      name: 'Current gap',
      value: '**' + Number(p.gap || 0).toLocaleString('en-US') + ' rep** · Chaos is #' + rank,
      inline: true,
    }, {
      name: 'Estimated window',
      value: 'Six-hour observed pace · ~' + etaLabel,
      inline: true,
    }, {
      name: 'Tracked rival',
      value: safeText(isChase ? p.defender_clan : p.challenger_clan),
      inline: true,
    });
  } else if (alert.event_type === 'lead_recovered') {
    color = 0x3ecf8e;
    title = '🛡️ Chaos rebuilt its safe lead';
    description = 'Chaos is now **' + Number(p.gap || 0).toLocaleString('en-US') +
      ' reputation ahead of ' + safeText(p.rival_clan) +
      '**, restoring a lead of more than ' + Number(p.safe_lead || 500).toLocaleString('en-US') + ' rep.';
    fields.push({
      name: 'Current position',
      value: 'Chaos **#' + rank + '** · **' + rep.toLocaleString('en-US') + ' rep**',
      inline: true,
    });
  }

  fields.push({
    name: 'Tracked season',
    value: season ? 'Season **' + season + '**' : 'Season unavailable',
    inline: true,
  });
  return {
    color,
    title,
    description,
    fields,
    footer: { text: 'Bleed Watch · automated clan rank defense · Asia/Manila' },
    timestamp: new Date(at).toISOString(),
  };
}

export async function dispatchChaosClanRivalryAlerts() {
  if (!SUPABASE_URL || !KEY) return { status: 'not_configured' };
  if (!HAS_BOT && !HAS_WEBHOOK) {
    return { status: 'not_configured', reason: 'Discord bot/channel or webhook is not configured' };
  }

  const response = await fetch(REST + '/rpc/claim_chaos_clan_rivalry_alerts', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_now: Date.now(), p_limit: 10, p_lease_ms: LEASE_MS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 350);
    throw new Error('Clan rivalry alert claim failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  const claimed = await response.json();
  const alerts = Array.isArray(claimed) ? claimed : [];
  if (!alerts.length) return { status: 'idle' };

  try {
    const nonce = 'cr-' + String(alerts[0].id).slice(-8) + '-' +
      String(alerts[alerts.length - 1].id).slice(-8);
    const messageId = await deliver({
      allowed_mentions: { parse: [] },
      embeds: alerts.slice(0, 10).map(makeClanRivalryEmbed),
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 5,
          label: 'Open Clan Ranking History',
          url: SITE + '/clan-comparison.html',
        }],
      }],
      nonce,
      enforce_nonce: true,
    });

    let confirmed = 0;
    for (const alert of alerts) {
      try {
        if (await finishClanRivalryAlert(alert, 'sent', { message_id: messageId }) === true) confirmed++;
      } catch (error) {
        console.error('Clan rivalry alert delivered but status was not confirmed:',
          Number(alert.id), String(error && error.message || error).slice(0, 250));
      }
    }
    return confirmed === alerts.length
      ? { status: 'sent', alerts: alerts.length, message_id: messageId }
      : { status: 'sent_unconfirmed', alerts: alerts.length, confirmed };
  } catch (error) {
    const now = Date.now();
    let rescheduled = 0;
    for (const alert of alerts) {
      const attempt = Math.max(1, Number(alert.attempt_count) || 1);
      const backoff = Math.min(4 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));
      try {
        if (await finishClanRivalryAlert(alert, 'failed', {
          error: String(error && error.message ? error.message : error).slice(0, 500),
          retry_at: now + backoff,
        }) === true) rescheduled++;
      } catch (updateError) {
        console.error('Could not schedule clan rivalry alert retry:',
          Number(alert.id), String(updateError.message || updateError).slice(0, 250));
      }
    }
    console.error('Clan rivalry Discord delivery failed:',
      String(error && error.message ? error.message : error).slice(0, 500));
    return { status: 'retry_scheduled', alerts: alerts.length, rescheduled };
  }
}


// ---------- Clan Rival Momentum & Overtake Forecast ----------

function momentumWindow(points, latestAt, hours) {
  const windowMs = hours * 60 * 60 * 1000;
  const targetAt = latestAt - windowMs;
  const toleranceMs = windowMs * 0.2;
  let baseline = null;
  let baselineDistance = Infinity;
  for (const point of points) {
    const distance = Math.abs(point.sample_at - targetAt);
    if (distance < baselineDistance) {
      baseline = point;
      baselineDistance = distance;
    }
  }
  if (!baseline || baselineDistance > toleranceMs) return null;
  const elapsedMs = latestAt - baseline.sample_at;
  if (elapsedMs < windowMs * 0.8 || elapsedMs > windowMs * 1.2) return null;
  const samples = points.filter(point =>
    point.sample_at >= baseline.sample_at && point.sample_at <= latestAt
  );
  const minimumSamples = hours === 1 ? 8 : hours === 6 ? 32 : 96;
  if (samples.length < minimumSamples) return null;
  const latest = points[points.length - 1];
  const gain = latest.reputation - baseline.reputation;
  return {
    gain,
    per_hour: Math.round((gain / (elapsedMs / 3600000)) * 100) / 100,
    elapsed_minutes: Math.round(elapsedMs / 60000),
    sample_count: samples.length,
    baseline_at: baseline.sample_at,
  };
}

function momentumEta(challenger, defender, windowKey) {
  if (!challenger || !defender) return null;
  const challengerRate = challenger['rep_per_hour_' + windowKey];
  const defenderRate = defender['rep_per_hour_' + windowKey];
  if (!Number.isFinite(challengerRate) || !Number.isFinite(defenderRate)) return null;
  const relativeRate = challengerRate - defenderRate;
  if (relativeRate <= 0) return null;
  const remaining = Math.max(0, defender.rep - challenger.rep) + 1;
  return Math.ceil((remaining / relativeRate) * 60);
}

export async function getClanMomentumForecast(seasonNumber = null, referenceAt = Date.now()) {
  if (!SUPABASE_URL || !KEY) return { status: 'not_configured', current_clans: [] };

  let activeSeason = Number(seasonNumber) || 0;
  if (!activeSeason) {
    const activeResponse = await fetch(
      REST + '/chaos_seasons?select=season_number&status=eq.active&order=season_number.desc&limit=1',
      { headers: H, signal: AbortSignal.timeout(TIMEOUT) }
    );
    if (!activeResponse.ok) throw new Error('Momentum active-season lookup failed: HTTP ' + activeResponse.status);
    const activeRows = await activeResponse.json();
    activeSeason = Array.isArray(activeRows) && activeRows[0] ? Number(activeRows[0].season_number) : 0;
  }
  if (!Number.isSafeInteger(activeSeason) || activeSeason < 1) {
    return { status: 'no_active_season', current_clans: [] };
  }

  const now = Number(referenceAt) || Date.now();
  const since = now - (24.5 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    select: 'sample_at,clan_name,rank_position,reputation',
    season_number: 'eq.' + activeSeason,
    sample_at: 'gte.' + Math.floor(since),
    order: 'sample_at.asc,rank_position.asc',
    limit: '5000',
  });
  const response = await fetch(REST + '/chaos_clan_rivalry_samples?' + params.toString(), {
    headers: H,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error('Clan momentum history read failed: HTTP ' + response.status +
      (detail ? ' · ' + detail : ''));
  }
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length) {
    return {
      status: 'warming',
      season_number: activeSeason,
      latest_sample_at: null,
      current_clans: [],
      recent_alerts: [],
      coverage: {
        one_hour_ready: false,
        six_hour_ready: false,
        twenty_four_hour_ready: false,
        all_rivals_ready: false,
      },
    };
  }

  const histories = new Map();
  let latestAt = 0;
  for (const row of rows) {
    const sampleAt = Number(row.sample_at);
    const rank = Number(row.rank_position);
    const rep = Number(row.reputation);
    const name = String(row.clan_name || '');
    if (!name || !Number.isFinite(sampleAt) || !Number.isFinite(rank) || !Number.isFinite(rep)) continue;
    latestAt = Math.max(latestAt, sampleAt);
    if (!histories.has(name)) histories.set(name, []);
    histories.get(name).push({ sample_at: sampleAt, rank, reputation: rep });
  }
  if (!latestAt || !histories.size) {
    return { status: 'warming', season_number: activeSeason, latest_sample_at: null, current_clans: [], recent_alerts: [] };
  }

  const ageMinutes = Math.max(0, Math.round((now - latestAt) / 60000));
  const stale = ageMinutes > 15;
  const currentClans = [];
  for (const [name, points] of histories) {
    points.sort((a, b) => a.sample_at - b.sample_at);
    const latest = points[points.length - 1];
    if (latest.sample_at < latestAt - 10 * 60 * 1000) continue;
    const oneHour = stale ? null : momentumWindow(points, latestAt, 1);
    const sixHour = stale ? null : momentumWindow(points, latestAt, 6);
    const twentyFourHour = stale ? null : momentumWindow(points, latestAt, 24);
    currentClans.push({
      name,
      rank: latest.rank,
      rep: latest.reputation,
      sample_at: latest.sample_at,
      rep_gain_1h: oneHour ? oneHour.gain : null,
      rep_per_hour_1h: oneHour ? oneHour.per_hour : null,
      samples_1h: oneHour ? oneHour.sample_count : 0,
      rep_gain_6h: sixHour ? sixHour.gain : null,
      rep_per_hour_6h: sixHour ? sixHour.per_hour : null,
      samples_6h: sixHour ? sixHour.sample_count : 0,
      rep_gain_24h: twentyFourHour ? twentyFourHour.gain : null,
      rep_per_hour_24h: twentyFourHour ? twentyFourHour.per_hour : null,
      samples_24h: twentyFourHour ? twentyFourHour.sample_count : 0,
    });
  }
  currentClans.sort((a, b) => a.rank - b.rank);
  const chaosIndex = currentClans.findIndex(clan => clan.name.toLowerCase() === 'chaos');
  const chaos = chaosIndex >= 0 ? currentClans[chaosIndex] : null;
  const above = chaosIndex > 0 ? currentClans[chaosIndex - 1] : null;
  const threat = chaosIndex >= 0 ? currentClans[chaosIndex + 1] || null : null;

  for (const clan of currentClans) {
    for (const key of ['1h', '6h', '24h']) {
      const ownRate = clan['rep_per_hour_' + key];
      const chaosRate = chaos && chaos['rep_per_hour_' + key];
      clan['relative_gain_per_hour_' + key] =
        Number.isFinite(ownRate) && Number.isFinite(chaosRate)
          ? Math.round((ownRate - chaosRate) * 100) / 100 : null;
      clan['eta_' + key + '_minutes'] = chaos && clan.rank > chaos.rank
        ? momentumEta(clan, chaos, key) : null;
      clan['chaos_overtake_' + key + '_minutes'] = chaos && clan.rank < chaos.rank
        ? momentumEta(chaos, clan, key) : null;
    }
  }

  const rankSet = new Set(currentClans.map(clan => clan.rank));
  const completeTopTen = Array.from({ length: 10 }, (_, index) => index + 1)
    .every(rank => rankSet.has(rank));
  function projectedLadder(hours, rateKey) {
    if (!completeTopTen) return null;
    const relevant = currentClans.filter(clan => clan.rank <= 10);
    if (relevant.length !== 10 || relevant.some(clan => !Number.isFinite(clan[rateKey]))) return null;
    return relevant.map(clan => ({
      name: clan.name,
      current_rank: clan.rank,
      current_rep: clan.rep,
      projected_rep: Math.round(clan.rep + clan[rateKey] * hours),
    })).sort((a, b) => b.projected_rep - a.projected_rep || a.current_rank - b.current_rank)
      .map((clan, index) => ({ ...clan, projected_rank: index + 1 }));
  }

  const oneHourLadder = projectedLadder(1, 'rep_per_hour_1h');
  const sixHourLadder = projectedLadder(6, 'rep_per_hour_6h');
  const twentyFourHourLadder = projectedLadder(24, 'rep_per_hour_24h');
  const allRivalsReady = !!(chaos && completeTopTen &&
    currentClans.every(clan => Number.isFinite(clan.rep_per_hour_6h)));

  // Include the top ten plus the sampled two-rank neighborhood around Chaos,
  // so rank defense still sees nearby challengers if Chaos leaves the top ten.
  const rivalForecasts = chaos ? currentClans
    .filter(clan => clan.name !== chaos.name)
    .map(clan => {
      const defense = clan.rank > chaos.rank;
      const challenger = defense ? clan : chaos;
      const defender = defense ? chaos : clan;
      const relativeRate = defense
        ? clan.relative_gain_per_hour_6h
        : Number.isFinite(clan.rep_per_hour_6h) && Number.isFinite(chaos.rep_per_hour_6h)
          ? Math.round((chaos.rep_per_hour_6h - clan.rep_per_hour_6h) * 100) / 100
          : null;
      const eta = defense ? clan.eta_6h_minutes : clan.chaos_overtake_6h_minutes;
      return {
        direction: defense ? 'defense' : 'chase',
        challenger_clan: challenger.name,
        defender_clan: defender.name,
        challenger_rep: challenger.rep,
        defender_rep: defender.rep,
        challenger_rank: challenger.rank,
        defender_rank: defender.rank,
        chaos_rep: chaos.rep,
        chaos_rank: chaos.rank,
        gap: Math.abs(chaos.rep - clan.rep),
        relative_gain_per_hour: relativeRate,
        eta_minutes: eta,
      };
    }) : [];

  // Competitive momentum score: percentile-ranked growth (70%) plus
  // consistency across independent measured windows (30%). Scores are only
  // issued when at least two real windows are available for a clan.
  const scoreWindows = [
    { key: '1h', weight: 0.2 },
    { key: '6h', weight: 0.5 },
    { key: '24h', weight: 0.3 },
  ];
  const rankedPercentiles = {};
  for (const window of scoreWindows) {
    const eligible = currentClans.filter(clan =>
      clan.rank <= 10 && Number.isFinite(clan['rep_per_hour_' + window.key])
    ).sort((a, b) => a['rep_per_hour_' + window.key] - b['rep_per_hour_' + window.key]);
    rankedPercentiles[window.key] = new Map();
    eligible.forEach((clan, index) => {
      const percentile = eligible.length <= 1 ? 100 : (index / (eligible.length - 1)) * 100;
      rankedPercentiles[window.key].set(clan.name, percentile);
    });
  }
  const momentumLeaderboard = currentClans.filter(clan => clan.rank <= 10).map(clan => {
    const available = scoreWindows.filter(window =>
      Number.isFinite(clan['rep_per_hour_' + window.key]) &&
      rankedPercentiles[window.key].has(clan.name)
    );
    if (available.length < 2) {
      return {
        name: clan.name, rank: clan.rank, reputation: clan.rep,
        score: null, growth_score: null, consistency_score: null,
        rep_per_hour_1h: clan.rep_per_hour_1h,
        rep_per_hour_6h: clan.rep_per_hour_6h,
        rep_per_hour_24h: clan.rep_per_hour_24h,
        windows_ready: available.map(window => window.key),
        status: 'building',
      };
    }
    const totalWeight = available.reduce((sum, window) => sum + window.weight, 0);
    const growthScore = available.reduce((sum, window) =>
      sum + rankedPercentiles[window.key].get(clan.name) * window.weight, 0
    ) / totalWeight;
    const rates = available.map(window => clan['rep_per_hour_' + window.key]);
    const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
    const variance = rates.reduce((sum, rate) => sum + Math.pow(rate - mean, 2), 0) / rates.length;
    const coefficient = Math.sqrt(variance) / Math.max(10, Math.abs(mean));
    const consistencyScore = Math.max(0, 100 - Math.min(100, coefficient * 100));
    const score = Math.round((growthScore * 0.7 + consistencyScore * 0.3) * 10) / 10;
    return {
      name: clan.name, rank: clan.rank, reputation: clan.rep,
      score, growth_score: Math.round(growthScore * 10) / 10,
      consistency_score: Math.round(consistencyScore * 10) / 10,
      rep_per_hour_1h: clan.rep_per_hour_1h,
      rep_per_hour_6h: clan.rep_per_hour_6h,
      rep_per_hour_24h: clan.rep_per_hour_24h,
      windows_ready: available.map(window => window.key),
      status: 'ready',
    };
  }).sort((a, b) => {
    if (a.score === null && b.score !== null) return 1;
    if (b.score === null && a.score !== null) return -1;
    return (b.score || 0) - (a.score || 0) || a.rank - b.rank;
  }).map((clan, index) => ({ ...clan, momentum_rank: index + 1 }));

  let recentAlerts = [];
  try {
    const alertParams = new URLSearchParams({
      select: 'event_type,payload,status,created_at,sent_at',
      event_type: 'in.(momentum_warning,chase_warning)',
      created_at: 'gte.' + Math.floor(now - 7 * 86400000),
      order: 'created_at.desc',
      limit: '12',
    });
    const alertResponse = await fetch(REST + '/chaos_clan_rivalry_alerts?' + alertParams.toString(), {
      headers: H,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (alertResponse.ok) recentAlerts = await alertResponse.json();
  } catch (alertError) {
    console.error('Recent clan momentum alerts unavailable:',
      String(alertError && alertError.message || alertError).slice(0, 250));
  }

  const oneHourReady = !!(chaos && Number.isFinite(chaos.rep_per_hour_1h));
  const sixHourReady = !!(chaos && Number.isFinite(chaos.rep_per_hour_6h));
  const twentyFourHourReady = !!(chaos && Number.isFinite(chaos.rep_per_hour_24h));
  const sixHourPairReady = !!(chaos && threat &&
    Number.isFinite(chaos.rep_per_hour_6h) && Number.isFinite(threat.rep_per_hour_6h));

  return {
    status: stale ? 'stale' : allRivalsReady ? 'ready' : 'warming',
    season_number: activeSeason,
    latest_sample_at: latestAt,
    sample_age_minutes: ageMinutes,
    current_clans: currentClans,
    chaos,
    above,
    threat,
    rival_forecasts: rivalForecasts,
    leaderboard: momentumLeaderboard,
    recent_alerts: Array.isArray(recentAlerts) ? recentAlerts : [],
    projection: {
      one_hour_rank: oneHourLadder
        ? oneHourLadder.find(clan => clan.name.toLowerCase() === 'chaos').projected_rank : null,
      six_hour_rank: sixHourLadder
        ? sixHourLadder.find(clan => clan.name.toLowerCase() === 'chaos').projected_rank : null,
      twenty_four_hour_rank: twentyFourHourLadder
        ? twentyFourHourLadder.find(clan => clan.name.toLowerCase() === 'chaos').projected_rank : null,
      ladders: {
        one_hour: oneHourLadder,
        six_hour: sixHourLadder,
        twenty_four_hour: twentyFourHourLadder,
      },
    },
    coverage: {
      one_hour_ready: oneHourReady,
      six_hour_ready: sixHourReady,
      six_hour_pair_ready: sixHourPairReady,
      twenty_four_hour_ready: twentyFourHourReady,
      all_rivals_ready: allRivalsReady,
      projection_ready: !!(oneHourLadder || sixHourLadder || twentyFourHourLadder),
      tracked_clans: currentClans.length,
      required_one_hour_samples: 8,
      required_six_hour_samples: 32,
      required_twenty_four_hour_samples: 96,
      required_window_coverage: '80% to 120% of target span',
    },
  };
}