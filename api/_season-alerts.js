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
