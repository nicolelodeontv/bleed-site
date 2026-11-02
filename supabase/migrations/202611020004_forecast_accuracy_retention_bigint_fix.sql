-- Correct 90-day retention arithmetic for bigint epoch timestamps.
create or replace function public.record_chaos_clan_forecast_accuracy(
  p_season_number integer,
  p_snapshot_at bigint,
  p_forecasts jsonb,
  p_actuals jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_forecast record;
  v_actuals jsonb;
  v_inserted integer := 0;
  v_evaluated integer := 0;
  v_expired integer := 0;
  v_row_count integer := 0;
  v_now bigint;
begin
  if p_season_number is null or p_season_number < 1
     or p_snapshot_at is null or p_snapshot_at < 1
     or jsonb_typeof(p_forecasts) is distinct from 'array'
     or jsonb_typeof(p_actuals) is distinct from 'array'
     or jsonb_array_length(p_forecasts) > 30
     or jsonb_array_length(p_actuals) > 20 then
    raise exception 'Invalid forecast accuracy payload';
  end if;

  v_now := p_snapshot_at;
  v_actuals := p_actuals;

  -- Evaluate with the first actual clan sample at/after the target time,
  -- provided it arrived within a 15-minute tolerance.
  with actual_rows as (
    select lower(trim(a.clan_name)) as clan_key,
           a.actual_rank,
           a.sample_at
      from jsonb_to_recordset(v_actuals)
        as a(clan_name text, actual_rank integer, sample_at bigint)
     where nullif(trim(a.clan_name), '') is not null
       and a.actual_rank between 1 and 10
       and a.sample_at is not null
  ),
  due as (
    select f.id, a.actual_rank, a.sample_at
      from public.chaos_clan_forecast_accuracy f
      join actual_rows a
        on lower(f.clan_name) = a.clan_key
       and a.sample_at >= f.target_at
       and a.sample_at <= f.target_at + 900000
       and a.sample_at <= v_now
     where f.season_number = p_season_number
       and f.evaluated_at is null
       and f.expired_at is null
       and f.target_at <= v_now
  )
  update public.chaos_clan_forecast_accuracy f
     set actual_rank = d.actual_rank,
         actual_at = d.sample_at,
         evaluated_at = d.sample_at,
         absolute_rank_error = abs(f.predicted_rank - d.actual_rank),
         signed_rank_error = f.predicted_rank - d.actual_rank,
         evaluation_delay_minutes = greatest(0, floor((d.sample_at - f.target_at) / 60000.0))::smallint
    from due d
   where f.id = d.id;
  get diagnostics v_evaluated = row_count;

  -- Expire only after the allowed actual-observation window has passed.
  update public.chaos_clan_forecast_accuracy
     set expired_at = v_now
   where season_number = p_season_number
     and evaluated_at is null
     and expired_at is null
     and target_at + 900000 < v_now;
  get diagnostics v_expired = row_count;

  -- Save each forecast window at most once per clan per 30 minutes.
  for v_forecast in
    select *
      from jsonb_to_recordset(p_forecasts)
        as f(horizon_hours integer, clan_name text, predicted_rank integer, projected_rep bigint)
  loop
    if v_forecast.horizon_hours not in (1, 6, 24)
       or nullif(trim(v_forecast.clan_name), '') is null
       or v_forecast.predicted_rank not between 1 and 10 then
      raise exception 'Invalid individual forecast row';
    end if;

    insert into public.chaos_clan_forecast_accuracy (
      season_number, forecast_at, target_at, horizon_hours,
      clan_name, predicted_rank, projected_rep, created_at
    )
    select
      p_season_number,
      v_now,
      v_now + (v_forecast.horizon_hours::bigint * 3600000),
      v_forecast.horizon_hours,
      trim(v_forecast.clan_name),
      v_forecast.predicted_rank,
      v_forecast.projected_rep,
      v_now
    where not exists (
      select 1
        from public.chaos_clan_forecast_accuracy prior
       where prior.season_number = p_season_number
         and prior.horizon_hours = v_forecast.horizon_hours
         and prior.clan_name = trim(v_forecast.clan_name)
         and prior.forecast_at > v_now - 1800000
    )
    on conflict (season_number, forecast_at, horizon_hours, clan_name) do nothing;

    get diagnostics v_row_count = row_count;
    v_inserted := v_inserted + v_row_count;
  end loop;

  -- Keep a bounded 90-day accuracy history; this table is private and compact.
  delete from public.chaos_clan_forecast_accuracy
   where season_number = p_season_number
     and forecast_at < v_now - (90::bigint * 86400000::bigint);

  return jsonb_build_object(
    'status', 'ok',
    'forecasts_saved', v_inserted,
    'forecasts_evaluated', v_evaluated,
    'forecasts_expired', v_expired
  );
end;
$$;

