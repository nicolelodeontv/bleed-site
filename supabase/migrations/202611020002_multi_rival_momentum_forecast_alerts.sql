-- Multi-rival rank-defense and chase alert episodes.
-- Each challenger/defender pair tracks its own warning thresholds and recovery.

create table if not exists public.chaos_clan_rivalry_forecast_states (
  season_number integer not null,
  challenger_clan text not null,
  defender_clan text not null,
  direction text not null check (direction in ('defense', 'chase')),
  episode integer not null default 0,
  alerted_thresholds integer[] not null default '{}',
  active boolean not null default false,
  last_eta_minutes integer,
  last_relative_gain_per_hour numeric,
  last_seen_at bigint not null,
  updated_at bigint not null,
  primary key (season_number, challenger_clan, defender_clan)
);

create index if not exists chaos_clan_rivalry_forecast_states_active_idx
  on public.chaos_clan_rivalry_forecast_states (season_number, active, last_seen_at desc);

alter table public.chaos_clan_rivalry_forecast_states enable row level security;
revoke all on public.chaos_clan_rivalry_forecast_states from public, anon, authenticated;
grant all on public.chaos_clan_rivalry_forecast_states to service_role;

alter table public.chaos_clan_rivalry_alerts
  drop constraint if exists chaos_clan_rivalry_alerts_event_type_check;
alter table public.chaos_clan_rivalry_alerts
  add constraint chaos_clan_rivalry_alerts_event_type_check
  check (event_type = any (array[
    'rank_gain'::text,
    'rank_loss'::text,
    'threat_warning'::text,
    'lead_recovered'::text,
    'momentum_warning'::text,
    'chase_warning'::text
  ]));

create or replace function public.process_chaos_clan_rivalry_forecast_alerts(
  p_season_number integer,
  p_forecasts jsonb,
  p_snapshot_at bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_challenger text;
  v_defender text;
  v_direction text;
  v_eta integer;
  v_relative numeric;
  v_gap bigint;
  v_chaos_rep bigint;
  v_chaos_rank integer;
  v_challenger_rank integer;
  v_defender_rank integer;
  v_state public.chaos_clan_rivalry_forecast_states%rowtype;
  v_episode integer;
  v_alerted integer[];
  v_threshold integer;
  v_event_type text;
  v_inserted integer;
  v_total_inserted integer := 0;
  v_processed integer := 0;
  v_closed integer := 0;
  v_now bigint;
begin
  if p_season_number is null or p_season_number < 1
     or p_snapshot_at is null or p_snapshot_at < 1
     or jsonb_typeof(p_forecasts) is distinct from 'array'
     or jsonb_array_length(p_forecasts) > 20 then
    raise exception 'Invalid multi-rival forecast payload';
  end if;

  perform pg_advisory_xact_lock(927451205);
  v_now := p_snapshot_at;

  for v_item in select value from jsonb_array_elements(p_forecasts)
  loop
    v_challenger := left(trim(coalesce(v_item ->> 'challenger_clan', '')), 120);
    v_defender := left(trim(coalesce(v_item ->> 'defender_clan', '')), 120);
    v_direction := v_item ->> 'direction';
    v_eta := nullif(v_item ->> 'eta_minutes', '')::integer;
    v_relative := nullif(v_item ->> 'relative_gain_per_hour', '')::numeric;
    v_gap := greatest(0, coalesce(nullif(v_item ->> 'gap', '')::bigint, 0));
    v_chaos_rep := greatest(0, coalesce(nullif(v_item ->> 'chaos_rep', '')::bigint, 0));
    v_chaos_rank := greatest(1, coalesce(nullif(v_item ->> 'chaos_rank', '')::integer, 1));
    v_challenger_rank := greatest(1, coalesce(nullif(v_item ->> 'challenger_rank', '')::integer, 1));
    v_defender_rank := greatest(1, coalesce(nullif(v_item ->> 'defender_rank', '')::integer, 1));

    if v_challenger = '' or v_defender = '' or v_challenger = v_defender
       or v_direction not in ('defense', 'chase') then
      raise exception 'Invalid rival pair in forecast payload';
    end if;

    insert into public.chaos_clan_rivalry_forecast_states (
      season_number, challenger_clan, defender_clan, direction,
      episode, alerted_thresholds, active, last_seen_at, updated_at
    ) values (
      p_season_number, v_challenger, v_defender, v_direction,
      0, '{}'::integer[], false, v_now, v_now
    )
    on conflict (season_number, challenger_clan, defender_clan) do nothing;

    select *
      into v_state
      from public.chaos_clan_rivalry_forecast_states
     where season_number = p_season_number
       and challenger_clan = v_challenger
       and defender_clan = v_defender
     for update;

    v_episode := v_state.episode;
    v_alerted := coalesce(v_state.alerted_thresholds, '{}'::integer[]);
    v_event_type := case when v_direction = 'chase' then 'chase_warning' else 'momentum_warning' end;

    if v_eta is null or v_eta < 0 or v_eta > 420 or coalesce(v_relative, 0) <= 0 then
      if v_state.active then
        v_episode := v_episode + 1;
      end if;

      update public.chaos_clan_rivalry_forecast_states
         set direction = v_direction,
             episode = v_episode,
             alerted_thresholds = '{}'::integer[],
             active = false,
             last_eta_minutes = v_eta,
             last_relative_gain_per_hour = v_relative,
             last_seen_at = v_now,
             updated_at = v_now
       where season_number = p_season_number
         and challenger_clan = v_challenger
         and defender_clan = v_defender;

      v_processed := v_processed + 1;
      continue;
    end if;

    foreach v_threshold in array array[360, 60] loop
      if v_eta <= v_threshold and not (v_threshold = any(v_alerted)) then
        insert into public.chaos_clan_rivalry_alerts (
          event_key, event_type, payload, status, attempt_count,
          next_attempt_at, lease_until, created_at, updated_at
        ) values (
          'multi_momentum:' || p_season_number || ':' ||
            md5(v_challenger || '|' || v_defender) || ':' ||
            v_episode || ':' || v_threshold,
          v_event_type,
          jsonb_build_object(
            'season_number', p_season_number,
            'forecast_direction', v_direction,
            'current_rank', v_chaos_rank,
            'chaos_rep', v_chaos_rep,
            'challenger_clan', v_challenger,
            'defender_clan', v_defender,
            'challenger_rank', v_challenger_rank,
            'defender_rank', v_defender_rank,
            'rival_clan', case when v_direction = 'defense' then v_challenger else v_defender end,
            'gap', v_gap,
            'eta_minutes', v_eta,
            'relative_gain_per_hour', round(v_relative, 2),
            'window_hours', 6,
            'threshold_minutes', v_threshold,
            'snapshot_at', v_now
          ),
          'pending',
          0,
          0,
          0,
          v_now,
          v_now
        )
        on conflict (event_key) do nothing;

        get diagnostics v_inserted = row_count;
        v_total_inserted := v_total_inserted + v_inserted;
        v_alerted := array_append(v_alerted, v_threshold);
      end if;
    end loop;

    update public.chaos_clan_rivalry_forecast_states
       set direction = v_direction,
           episode = v_episode,
           alerted_thresholds = v_alerted,
           active = true,
           last_eta_minutes = v_eta,
           last_relative_gain_per_hour = v_relative,
           last_seen_at = v_now,
           updated_at = v_now
     where season_number = p_season_number
       and challenger_clan = v_challenger
       and defender_clan = v_defender;

    v_processed := v_processed + 1;
  end loop;

  -- Close a prior episode after a clan drops out of the monitored top ten
  -- for 15 minutes of otherwise complete, fresh samples.
  update public.chaos_clan_rivalry_forecast_states
     set active = false,
         episode = episode + 1,
         alerted_thresholds = '{}'::integer[],
         updated_at = v_now
   where season_number = p_season_number
     and active
     and last_seen_at < v_now - 900000;
  get diagnostics v_closed = row_count;

  return jsonb_build_object(
    'status', case when v_total_inserted > 0 then 'queued' else 'processed' end,
    'processed_pairs', v_processed,
    'queued_alerts', v_total_inserted,
    'closed_stale_episodes', v_closed
  );
end;
$$;

revoke all on function public.process_chaos_clan_rivalry_forecast_alerts(integer, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.process_chaos_clan_rivalry_forecast_alerts(integer, jsonb, bigint)
  to service_role;
