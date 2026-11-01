-- Refresh the rollover Discord payload after all season award triggers have run.
create or replace function public.attach_chaos_season_awards_to_rollover_alert()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_awards jsonb := '[]'::jsonb;
begin
  if new.previous_season_number is null then
    return new;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'award_key', award_key,
        'award_title', case
          when award_key = 'season_champion' then 'Season MVP'
          else award_title
        end,
        'metric_key', metric_key,
        'winning_value', winning_value,
        'winners', winners
      )
      order by case award_key
        when 'season_champion' then 1
        when 'most_improved' then 2
        when 'rookie_of_season' then 3
        when 'most_active' then 4
        when 'consistency' then 5
        when 'most_recorded_increases' then 6
        else 99
      end, award_key
    ),
    '[]'::jsonb
  )
  into v_awards
  from public.chaos_season_awards
  where season_number = new.previous_season_number;

  new.payload := jsonb_set(
    coalesce(new.payload, '{}'::jsonb),
    '{previous_awards}',
    v_awards,
    true
  );
  return new;
end;
$function$;

revoke all on function public.attach_chaos_season_awards_to_rollover_alert() from public;
revoke all on function public.attach_chaos_season_awards_to_rollover_alert() from anon, authenticated;
grant execute on function public.attach_chaos_season_awards_to_rollover_alert() to service_role;

drop trigger if exists chaos_season_alert_awards_before_insert on public.chaos_season_alerts;
create trigger chaos_season_alert_awards_before_insert
before insert on public.chaos_season_alerts
for each row
when (new.previous_season_number is not null)
execute function public.attach_chaos_season_awards_to_rollover_alert();

comment on function public.attach_chaos_season_awards_to_rollover_alert()
is 'Refreshes rollover Discord alert award data from the completed season archive before the alert is queued.';
