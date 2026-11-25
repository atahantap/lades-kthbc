-- Lades — KTH Basketball Team (Osqvik Christmas Party)
-- Safe to run on both a fresh database and an existing one (preserves existing data).
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

-- 2. Lades events table (+1 winner, -1 loser, soft-delete via deleted_at)
create table if not exists public.lades_events (
  id uuid primary key default gen_random_uuid(),
  winner_id uuid not null references public.players(id) on delete cascade,
  loser_id uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz default null,
  constraint no_self_lades check (winner_id <> loser_id)
);

-- Ensure deleted_at exists when upgrading an already-created table
alter table public.lades_events
  add column if not exists deleted_at timestamptz default null;

create index if not exists lades_events_created_at_idx
  on public.lades_events (created_at desc);

create index if not exists lades_events_active_idx
  on public.lades_events (created_at desc)
  where deleted_at is null;

-- 3. Schema & table permissions + Row Level Security
-- Public users can ONLY read and insert. DELETE and direct UPDATE are revoked;
-- only the 30-second soft-delete RPC below can mark a just-created row as undone.
grant usage on schema public to anon, authenticated;
revoke all on table public.players from anon, authenticated;
revoke all on table public.lades_events from anon, authenticated;
grant select, insert on table public.players to anon, authenticated;
grant select, insert on table public.lades_events to anon, authenticated;

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
  with check (winner_id <> loser_id and deleted_at is null);

drop policy if exists "Public delete events" on public.lades_events;

-- 4. Controlled 30-second soft-undo RPC (only way public users can undo a misclick)
create or replace function public.undo_recent_lades(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_rows integer;
begin
  update public.lades_events
  set deleted_at = now()
  where id = p_event_id
    and deleted_at is null
    and created_at >= now() - interval '30 seconds';

  get diagnostics affected_rows = row_count;
  return affected_rows > 0;
end;
$$;

revoke all on function public.undo_recent_lades(uuid) from public;
grant execute on function public.undo_recent_lades(uuid) to anon, authenticated;

-- 5. Enable live updates via Supabase Realtime (idempotent)
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
