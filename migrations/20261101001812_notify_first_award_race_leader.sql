-- A race category can be seeded with no qualifiers. Notify when its first leader appears.
create or replace function public.record_chaos_award_race_snapshot(
  p_season_number integer,
  p_snapshot jsonb,
  p_now bigint
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_status text;
  v_previous jsonb;
  v_current_award jsonb;
  v_previous_award jsonb;
  v_key text;
  v_previous_leaders text[];
  v_current_leaders text[];
  v_gained text[];
  v_lost text[];
  v_event_type text;
  v_events jsonb := '[]'::jsonb;
  v_event_key text;
  v_alert_id bigint;
begin
  if p_season_number is null or p_season_number <= 0 then
    raise exception 'p_season_number must be positive';
  end if;
  if p_now is null or p_now <= 0 then
    raise exception 'p_now must be a positive Unix timestamp in milliseconds';
  end if;
  if p_snapshot is null
     or jsonb_typeof(p_snapshot) is distinct from 'object'
     or jsonb_typeof(p_snapshot->'awards') is distinct from 'object' then
    raise exception 'p_snapshot must contain an awards object';
  end if;
  if coalesce(nullif(p_snapshot->>'season_number', '')::integer, p_season_number)
     <> p_season_number then
    raise exception 'snapshot season number does not match p_season_number';
  end if;

  select status
    into v_status
    from public.chaos_seasons
    where season_number = p_season_number;

  if v_status is distinct from 'active' then
    return jsonb_build_object('status', 'inactive_season', 'season_number', p_season_number);
  end if;

  insert into public.chaos_award_race_state(season_number, snapshot, updated_at)
  values (p_season_number, '{}'::jsonb, p_now)
  on conflict (season_number) do nothing;

  select snapshot
    into v_previous
    from public.chaos_award_race_state
    where season_number = p_season_number
    for update;

  if jsonb_typeof(v_previous->'awards') is distinct from 'object' then
    update public.chaos_award_race_state
      set snapshot = p_snapshot,
          updated_at = p_now
      where season_number = p_season_number;
    return jsonb_build_object('status', 'seeded', 'season_number', p_season_number, 'events', 0);
  end if;

  for v_key, v_current_award in
    select key, value
      from jsonb_each(p_snapshot->'awards')
  loop
    v_previous_award := v_previous->'awards'->v_key;

    -- Compare categories present in both snapshots. An empty previous leader
    -- set is meaningful: the first member to qualify takes the new lead.
    if jsonb_typeof(v_previous_award) is distinct from 'object'
       or coalesce((v_current_award->>'available')::boolean, false) is not true then
      continue;
    end if;

    select coalesce(array_agg(item.value order by item.value), array[]::text[])
      into v_previous_leaders
      from jsonb_array_elements_text(coalesce(v_previous_award->'leaders', '[]'::jsonb)) item(value);

    select coalesce(array_agg(item.value order by item.value), array[]::text[])
      into v_current_leaders
      from jsonb_array_elements_text(coalesce(v_current_award->'leaders', '[]'::jsonb)) item(value);

    if cardinality(v_current_leaders) = 0
       or v_current_leaders = v_previous_leaders then
      continue;
    end if;

    v_gained := array(
      select member_name
        from unnest(v_current_leaders) member_name
        where not (member_name = any(v_previous_leaders))
        order by member_name
    );
    v_lost := array(
      select member_name
        from unnest(v_previous_leaders) member_name
        where not (member_name = any(v_current_leaders))
        order by member_name
    );

    v_event_type := case
      when cardinality(v_current_leaders) > 1 and cardinality(v_previous_leaders) > 1
        then 'tie_changed'
      when cardinality(v_current_leaders) > 1
        then 'tied_for_first'
      when cardinality(v_previous_leaders) > 1
        then 'tie_broken'
      else 'lead_change'
    end;

    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'award_key', v_key,
      'award_title', coalesce(v_current_award->>'title', v_key),
      'event_type', v_event_type,
      'previous_leaders', to_jsonb(v_previous_leaders),
      'current_leaders', to_jsonb(v_current_leaders),
      'gained_leaders', to_jsonb(v_gained),
      'lost_leaders', to_jsonb(v_lost),
      'winning_value', coalesce(v_current_award->'winning_value', 'null'::jsonb),
      'previous_value', coalesce(v_previous_award->'winning_value', 'null'::jsonb),
      'unit', coalesce(v_current_award->>'unit', '')
    ));
  end loop;

  update public.chaos_award_race_state
    set snapshot = p_snapshot,
        updated_at = p_now
    where season_number = p_season_number;

  if jsonb_array_length(v_events) = 0 then
    return jsonb_build_object('status', 'unchanged', 'season_number', p_season_number, 'events', 0);
  end if;

  v_event_key := md5(p_season_number::text || ':' || p_now::text || ':' || v_events::text);

  insert into public.chaos_award_race_alerts (
    season_number, event_key, snapshot_at, payload, status,
    attempt_count, next_attempt_at, lease_until, created_at, updated_at
  )
  values (
    p_season_number,
    v_event_key,
    p_now,
    jsonb_build_object(
      'season_number', p_season_number,
      'generated_at', p_now,
      'events', v_events
    ),
    'pending',
    0,
    p_now,
    0,
    p_now,
    p_now
  )
  on conflict (season_number, event_key) do nothing
  returning id into v_alert_id;

  if v_alert_id is null then
    return jsonb_build_object('status', 'already_queued', 'season_number', p_season_number, 'events', jsonb_array_length(v_events));
  end if;

  return jsonb_build_object(
    'status', 'queued',
    'id', v_alert_id,
    'season_number', p_season_number,
    'events', jsonb_array_length(v_events)
  );
end;
$function$;

revoke all on function public.record_chaos_award_race_snapshot(integer, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.record_chaos_award_race_snapshot(integer, jsonb, bigint) to service_role;

comment on function public.record_chaos_award_race_snapshot(integer, jsonb, bigint)
  is 'Atomically compares provisional award leader sets, including first qualifying leaders, and queues one alert digest when leaders change.';