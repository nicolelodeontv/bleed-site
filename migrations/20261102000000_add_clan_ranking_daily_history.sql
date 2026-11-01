create table public.clan_ranking_daily (
  snapshot_date date not null,
  clan_name text not null check (length(btrim(clan_name)) > 0),
  rank_position integer not null check (rank_position > 0),
  master_name text not null default '',
  member_count integer not null default 0 check (member_count >= 0),
  member_capacity integer not null default 0 check (member_capacity >= 0),
  reputation bigint not null default 0 check (reputation >= 0),
  captured_at bigint not null,
  constraint clan_ranking_daily_pkey primary key (snapshot_date, clan_name)
);
create index clan_ranking_daily_date_rank_idx on public.clan_ranking_daily (snapshot_date desc, rank_position asc);
create index clan_ranking_daily_clan_date_idx on public.clan_ranking_daily (clan_name, snapshot_date desc);
alter table public.clan_ranking_daily enable row level security;
revoke all on table public.clan_ranking_daily from public, anon, authenticated;
grant select, insert, update on table public.clan_ranking_daily to service_role;
comment on table public.clan_ranking_daily is
  'One daily Asia/Manila clan-ranking snapshot per clan; written only by the server-side tracker.';
