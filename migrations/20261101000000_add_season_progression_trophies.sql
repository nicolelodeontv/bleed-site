-- Add season progression awards without changing the existing rollover transaction.
-- This AFTER UPDATE trigger runs inside record_chaos_poll's rollover transaction:
-- existing four awards are written first, then these two are added before the
-- rollover Discord payload reads the completed season's award archive.

create or replace function public.add_chaos_season_progression_awards()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_previous_season integer := new.season_number - 1;
  v_current_days numeric;
  v_previous_days numeric;
begin
  if old.status is distinct from 'active'
     or new.status is distinct from 'completed'
     or new.end_reason is distinct from 'mass_reputation_reset'
     or new.started_at is null
     or new.ended_at is null then
    return new;
  end if;

  v_current_days := greatest(
    (new.ended_at - new.started_at)::numeric / 86400000.0,
    1.0
  );

  select greatest(
    (previous.ended_at - previous.started_at)::numeric / 86400000.0,
    1.0
  )
    into v_previous_days
    from public.chaos_seasons previous
    where previous.season_number = v_previous_season
      and previous.status = 'completed'
      and previous.started_at is not null
      and previous.ended_at is not null;

  -- Most Improved compares season reputation gained per elapsed calendar day
  -- against the immediately preceding tracked season. Values are stored in
  -- milli-reputation/day so the existing bigint award value stays precise.
  if v_previous_days is not null then
    with metric_rows as (
      select
        current_stats.member,
        round((
          current_stats.season_gain::numeric / v_current_days
          - previous_stats.season_gain::numeric / v_previous_days
        ) * 1000)::bigint as metric_value,
        jsonb_build_object(
          'member', current_stats.member,
          'value', round((
            current_stats.season_gain::numeric / v_current_days
            - previous_stats.season_gain::numeric / v_previous_days
          ) * 1000)::bigint,
          'current_season_gain', current_stats.season_gain,
          'previous_season_gain', previous_stats.season_gain,
          'current_rep_per_day', round(current_stats.season_gain::numeric / v_current_days, 3),
          'previous_rep_per_day', round(previous_stats.season_gain::numeric / v_previous_days, 3)
        ) as winner_detail
      from public.chaos_season_member_stats current_stats
      join public.chaos_season_member_stats previous_stats
        on previous_stats.member = current_stats.member
       and previous_stats.season_number = v_previous_season
      where current_stats.season_number = new.season_number
        and current_stats.season_gain > 0
        and previous_stats.season_gain > 0
    ),
    eligible as (
      select * from metric_rows where metric_value > 0
    ),
    best as (
      select max(metric_value)::bigint as winning_value, count(*)::integer as eligible_count
      from eligible
    )
    insert into public.chaos_season_awards (
      season_number, award_key, award_title, metric_key,
      winning_value, winners, eligible_count, decided_at, award_version
    )
    select
      new.season_number,
      'most_improved',
      'Most Improved',
      'rep_per_day_improvement_milli',
      best.winning_value,
      jsonb_agg(eligible.winner_detail order by eligible.member),
      best.eligible_count,
      new.ended_at,
      2
    from best
    join eligible on eligible.metric_value = best.winning_value
    where best.winning_value > 0
    group by best.winning_value, best.eligible_count
    on conflict (season_number, award_key) do nothing;

    -- Rookie is available only when a preceding season exists. A member is a
    -- newcomer only when no member-stat row exists in that prior season.
    with metric_rows as (
      select
        current_stats.member,
        current_stats.season_gain::bigint as metric_value,
        jsonb_build_object(
          'member', current_stats.member,
          'value', current_stats.season_gain::bigint
        ) as winner_detail
      from public.chaos_season_member_stats current_stats
      where current_stats.season_number = new.season_number
        and current_stats.season_gain > 0
        and not exists (
          select 1
          from public.chaos_season_member_stats previous_stats
          where previous_stats.season_number = v_previous_season
            and previous_stats.member = current_stats.member
        )
    ),
    best as (
      select max(metric_value)::bigint as winning_value, count(*)::integer as eligible_count
      from metric_rows
    )
    insert into public.chaos_season_awards (
      season_number, award_key, award_title, metric_key,
      winning_value, winners, eligible_count, decided_at, award_version
    )
    select
      new.season_number,
      'rookie_of_season',
      'Rookie of the Season',
      'season_gain',
      best.winning_value,
      jsonb_agg(metric_rows.winner_detail order by metric_rows.member),
      best.eligible_count,
      new.ended_at,
      2
    from best
    join metric_rows on metric_rows.metric_value = best.winning_value
    where best.winning_value > 0
    group by best.winning_value, best.eligible_count
    on conflict (season_number, award_key) do nothing;
  end if;

  return new;
end;
$function$;

revoke all on function public.add_chaos_season_progression_awards() from public;
revoke all on function public.add_chaos_season_progression_awards() from anon, authenticated;
grant execute on function public.add_chaos_season_progression_awards() to service_role;

drop trigger if exists chaos_season_progression_awards_after_close on public.chaos_seasons;
create trigger chaos_season_progression_awards_after_close
after update of status on public.chaos_seasons
for each row
when (old.status = 'active' and new.status = 'completed')
execute function public.add_chaos_season_progression_awards();

comment on function public.add_chaos_season_progression_awards()
is 'Adds Most Improved and Rookie of the Season awards atomically when a tracked season closes.';
