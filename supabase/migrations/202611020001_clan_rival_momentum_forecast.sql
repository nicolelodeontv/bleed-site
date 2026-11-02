-- Clan Rival Momentum & Overtake Forecast
-- Samples the leading clans and Chaos's immediate rivals every five minutes.
-- Private to the server role; old samples are pruned by the sampling RPC.

create table if not exists public.chaos_clan_rivalry_samples (
  sample_at bigint not null,
  season_number integer not null,
  clan_name text not null,
  rank_position integer not null check (rank_position > 0),
  reputation bigint not null check (reputation >= 0),
  primary key (season_number, sample_at, clan_name)
);

create index if not exists chaos_clan_rivalry_samples_clan_time_idx
  on public.chaos_clan_rivalry_samples (season_number, clan_name, sample_at desc);
create index if not exists chaos_clan_rivalry_samples_time_idx
  on public.chaos_clan_rivalry_samples (season_number, sample_at desc);

alter table public.chaos_clan_rivalry_samples enable row level security;
revoke all on public.chaos_clan_rivalry_samples from public, anon, authenticated;
grant all on public.chaos_clan_rivalry_samples to service_role;

alter table public.chaos_clan_rivalry_state
  add column if not exists forecast_season_number integer not null default 0,
  add column if not exists forecast_rival text,
  add column if not exists forecast_episode integer not null default 0,
  add column if not exists forecast_alerted_thresholds integer[] not null default '{}';

alter table public.chaos_clan_rivalry_alerts
  drop constraint if exists chaos_clan_rivalry_alerts_event_type_check;
alter table public.chaos_clan_rivalry_alerts
  add constraint chaos_clan_rivalry_alerts_event_type_check
  check (event_type = any (array[
    'rank_gain'::text,
    'rank_loss'::text,
    'threat_warning'::text,
    'lead_recovered'::text,
    'momentum_warning'::text
  ]));

create or replace function public.record_chaos_clan_rivalry_samples(
  p_season_number integer,
  p_sample_at bigint,
  p_clans jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_last_sample_at bigint;
  v_saved integer := 0;
begin
  if p_season_number is null or p_season_number < 1
     or p_sample_at is null or p_sample_at < 1
     or jsonb_typeof(p_clans) is distinct from 'array'
     or jsonb_array_length(p_clans) < 1
     or jsonb_array_length(p_clans) > 20 then
    raise exception 'Invalid clan rivalry sample payload';
  end if;

  perform pg_advisory_xact_lock(927451203);

  select max(sample_at)
    into v_last_sample_at
    from public.chaos_clan_rivalry_samples
   where season_number = p_season_number;

  if v_last_sample_at is not null and p_sample_at <= v_last_sample_at then
    return jsonb_build_object('status', 'stale', 'last_sample_at', v_last_sample_at, 'saved', 0);
  end if;

  if v_last_sample_at is not null and p_sample_at - v_last_sample_at < 300000 then
    return jsonb_build_object('status', 'throttled', 'last_sample_at', v_last_sample_at, 'saved', 0);
  end if;

  insert into public.chaos_clan_rivalry_samples (
    sample_at, season_number, clan_name, rank_position, reputation
  )
  select
    p_sample_at,
    p_season_number,
    left(trim(item ->> 'name'), 120),
    greatest(1, coalesce((item ->> 'rank')::integer, 1)),
    greatest(0, coalesce((item ->> 'rep')::bigint, 0))
  from jsonb_array_elements(p_clans) as item
  where nullif(trim(item ->> 'name'), '') is not null
  on conflict (season_number, sample_at, clan_name) do nothing;

  get diagnostics v_saved = row_count;

  delete from public.chaos_clan_rivalry_samples
   where sample_at < p_sample_at - 691200000;

  return jsonb_build_object(
    'status', case when v_saved > 0 then 'saved' else 'empty' end,
    'sample_at', p_sample_at,
    'saved', v_saved,
    'retention_days', 8
  );
end;
$$;

revoke all on function public.record_chaos_clan_rivalry_samples(integer, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_chaos_clan_rivalry_samples(integer, bigint, jsonb)
  to service_role;

create or replace function public.process_chaos_clan_rivalry_forecast_alert(
  p_season_number integer,
  p_rival_clan text,
  p_eta_minutes integer,
  p_relative_gain_per_hour numeric,
  p_window_hours integer,
  p_current_rank integer,
  p_chaos_rep bigint,
  p_gap bigint,
  p_snapshot_at bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_state public.chaos_clan_rivalry_state%rowtype;
  v_episode integer;
  v_alerted integer[];
  v_threshold integer;
  v_inserted integer := 0;
  v_total_inserted integer := 0;
begin
  if p_season_number is null or p_season_number < 1 then
    raise exception 'Invalid season number';
  end if;

  perform pg_advisory_xact_lock(927451204);

  select *
    into v_state
    from public.chaos_clan_rivalry_state
   where id = 1
   for update;

  if not found then
    return jsonb_build_object('status', 'state_missing', 'queued', 0);
  end if;

  if v_state.season_number <> p_season_number then
    return jsonb_build_object('status', 'season_mismatch', 'queued', 0);
  end if;

  v_episode := v_state.forecast_episode;
  v_alerted := coalesce(v_state.forecast_alerted_thresholds, '{}'::integer[]);

  if v_state.forecast_season_number <> p_season_number then
    v_episode := 0;
    v_alerted := '{}'::integer[];
  elsif v_state.forecast_rival is distinct from p_rival_clan then
    v_episode := v_episode + 1;
    v_alerted := '{}'::integer[];
  end if;

  if p_rival_clan is null
     or p_eta_minutes is null
     or p_eta_minutes > 420
     or coalesce(p_relative_gain_per_hour, 0) <= 0 then
    if cardinality(v_alerted) > 0 then
      v_episode := v_episode + 1;
    end if;
    update public.chaos_clan_rivalry_state
       set forecast_season_number = p_season_number,
           forecast_rival = p_rival_clan,
           forecast_episode = v_episode,
           forecast_alerted_thresholds = '{}'::integer[],
           updated_at = coalesce(p_snapshot_at, (extract(epoch from clock_timestamp()) * 1000)::bigint)
     where id = 1;
    return jsonb_build_object('status', 'no_active_forecast_risk', 'queued', 0, 'episode', v_episode);
  end if;

  foreach v_threshold in array array[360, 60] loop
    if p_eta_minutes <= v_threshold and not (v_threshold = any(v_alerted)) then
      insert into public.chaos_clan_rivalry_alerts (
        event_key, event_type, payload, status, attempt_count,
        next_attempt_at, lease_until, created_at, updated_at
      ) values (
        'momentum:' || p_season_number || ':' || v_episode || ':' ||
          md5(p_rival_clan) || ':' || v_threshold,
        'momentum_warning',
        jsonb_build_object(
          'season_number', p_season_number,
          'current_rank', coalesce(p_current_rank, 0),
          'chaos_rep', coalesce(p_chaos_rep, 0),
          'rival_clan', p_rival_clan,
          'gap', coalesce(p_gap, 0),
          'eta_minutes', p_eta_minutes,
          'relative_gain_per_hour', round(p_relative_gain_per_hour, 2),
          'window_hours', coalesce(p_window_hours, 6),
          'threshold_minutes', v_threshold,
          'snapshot_at', coalesce(p_snapshot_at, (extract(epoch from clock_timestamp()) * 1000)::bigint)
        ),
        'pending',
        0,
        0,
        0,
        coalesce(p_snapshot_at, (extract(epoch from clock_timestamp()) * 1000)::bigint),
        coalesce(p_snapshot_at, (extract(epoch from clock_timestamp()) * 1000)::bigint)
      )
      on conflict (event_key) do nothing;

      get diagnostics v_inserted = row_count;
      v_total_inserted := v_total_inserted + v_inserted;
      v_alerted := array_append(v_alerted, v_threshold);
    end if;
  end loop;

  update public.chaos_clan_rivalry_state
     set forecast_season_number = p_season_number,
         forecast_rival = p_rival_clan,
         forecast_episode = v_episode,
         forecast_alerted_thresholds = v_alerted,
         updated_at = coalesce(p_snapshot_at, (extract(epoch from clock_timestamp()) * 1000)::bigint)
   where id = 1;

  return jsonb_build_object(
    'status', case when v_total_inserted > 0 then 'queued' else 'clear_or_already_alerted' end,
    'queued', v_total_inserted,
    'episode', v_episode,
    'alerted_thresholds', v_alerted
  );
end;
$$;

revoke all on function public.process_chaos_clan_rivalry_forecast_alert(
  integer, text, integer, numeric, integer, integer, bigint, bigint, bigint
) from public, anon, authenticated;
grant execute on function public.process_chaos_clan_rivalry_forecast_alert(
  integer, text, integer, numeric, integer, integer, bigint, bigint, bigint
) to service_role;
