-- Lades — KTH Basketball Team (Osqvik Christmas Party)
-- Paste this into Supabase Dashboard -> SQL Editor -> New Query, then click Run.

create extension if not exists pgcrypto;

-- 1. Players table
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 32),
  created_at timestamptz not null default now()
);

create unique index if not exists players_name_lower_idx
  on public.players (lower(trim(name)));

-- 2. Lades events table (+1 winner, -1 loser)
create table if not exists public.lades_events (
  id uuid primary key default gen_random_uuid(),
  winner_id uuid not null references public.players(id) on delete cascade,
  loser_id uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint no_self_lades check (winner_id <> loser_id)
);

create index if not exists lades_events_created_at_idx
  on public.lades_events (created_at desc);

-- 3. Schema & table permissions + Row Level Security (open to anyone with the team link)
grant usage on schema public to anon, authenticated;
grant select, insert on table public.players to anon, authenticated;
grant select, insert, delete on table public.lades_events to anon, authenticated;

alter table public.players enable row level security;
alter table public.lades_events enable row level security;

drop policy if exists "Public read players" on public.players;
create policy "Public read players"
  on public.players for select
  to anon, authenticated
  using (true);

drop policy if exists "Public insert players" on public.players;
create policy "Public insert players"
  on public.players for insert
  to anon, authenticated
  with check (char_length(trim(name)) between 1 and 32);

drop policy if exists "Public read events" on public.lades_events;
create policy "Public read events"
  on public.lades_events for select
  to anon, authenticated
  using (true);

drop policy if exists "Public insert events" on public.lades_events;
create policy "Public insert events"
  on public.lades_events for insert
  to anon, authenticated
  with check (winner_id <> loser_id);

drop policy if exists "Public delete events" on public.lades_events;
create policy "Public delete events"
  on public.lades_events for delete
  to anon, authenticated
  using (true);

-- 4. Enable live updates via Supabase Realtime (idempotent)
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lades_events'
  ) then
    alter publication supabase_realtime add table public.lades_events;
  end if;
end $$;
