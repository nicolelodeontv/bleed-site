-- Finished-bleed history. api/_lib.js writes one row per finished bleed and api/history.js reads the last 24h.
-- Without this table the "Finished bleeds" list on the home page can never show anything.
create table if not exists public.bleed_events (
  id bigint generated always as identity primary key,
  name text not null,
  since bigint not null,
  last_drop bigint not null,
  lost bigint not null,
  ended_at bigint not null
);

comment on table public.bleed_events is 'One row per finished clan bleed; written and read only by the server-side tracker (service role).';

create index if not exists bleed_events_ended_at_idx on public.bleed_events (ended_at desc);

-- Same posture as the other tables: RLS on with no policies, so only the service role can read or write.
alter table public.bleed_events enable row level security;
