-- Statistik für die Admin-Seite: Ereigniszähler (je Stunde, frei benannt), letzter Prüflauf, App installiert ja/nein
alter table public.rb_stats add column if not exists ev jsonb not null default '{}'::jsonb;
alter table public.rb_stats add column if not exists last_at timestamptz;
alter table public.rb_devices add column if not exists app boolean;

create or replace function public.rb_stats_ev(p_hour timestamptz, p_ev jsonb) returns void language sql security definer set search_path = public as $$
  insert into rb_stats as s (hour, ev) values (p_hour, p_ev)
  on conflict (hour) do update set ev = (
    select coalesce(jsonb_object_agg(k, coalesce((s.ev->>k)::numeric, 0) + coalesce((excluded.ev->>k)::numeric, 0)), '{}'::jsonb)
    from (select jsonb_object_keys(s.ev) k union select jsonb_object_keys(excluded.ev)) keys);
$$;
revoke all on function public.rb_stats_ev(timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.rb_stats_ev(timestamptz, jsonb) to service_role;

create or replace function public.rb_stats_add(p_hour timestamptz, p_db int, p_db429 int, p_vbb int, p_motis int, p_ai int, p_runs int, p_checks int, p_trips int)
returns void language sql security definer set search_path = public as $$
  insert into rb_stats as s (hour, db, db429, vbb, motis, ai, runs, checks, trips_max, db_max_run, last_at)
  values (p_hour, p_db, p_db429, p_vbb, p_motis, p_ai, p_runs, p_checks, p_trips, case when p_runs > 0 then p_db else 0 end, case when p_runs > 0 then now() end)
  on conflict (hour) do update set db = s.db + excluded.db, db429 = s.db429 + excluded.db429, vbb = s.vbb + excluded.vbb,
    motis = s.motis + excluded.motis, ai = s.ai + excluded.ai, runs = s.runs + excluded.runs, checks = s.checks + excluded.checks,
    trips_max = greatest(s.trips_max, excluded.trips_max), db_max_run = greatest(s.db_max_run, excluded.db_max_run),
    last_at = greatest(s.last_at, excluded.last_at);
$$;

create or replace function public.rb_overview() returns json language sql security definer set search_path = public as $$
  select json_build_object(
    'accounts', (select count(*) from rb_accounts),
    'devices', (select count(*) from rb_devices),
    'multi', (select count(*) from (select account_id from rb_devices group by account_id having count(*) > 1) m),
    'active_1h', (select count(*) from rb_devices where last_seen > now() - interval '75 minutes'),
    'active_24h', (select count(*) from rb_devices where last_seen > now() - interval '24 hours'),
    'devices_7d', (select count(*) from rb_devices where last_seen > now() - interval '7 days'),
    'active_30d', (select count(*) from rb_devices where last_seen > now() - interval '30 days'),
    'acc_active_7d', (select count(distinct account_id) from rb_devices where last_seen > now() - interval '7 days'),
    'devices_new_7d', (select count(*) from rb_devices where created_at > now() - interval '7 days'),
    'devices_new_30d', (select count(*) from rb_devices where created_at > now() - interval '30 days'),
    'ret_base', (select count(*) from rb_devices where created_at between now() - interval '14 days' and now() - interval '7 days'),
    'ret_kept', (select count(*) from rb_devices where created_at between now() - interval '14 days' and now() - interval '7 days' and last_seen > created_at + interval '6 days'),
    'app', (select count(*) from rb_devices where app and last_seen > now() - interval '30 days'),
    'push', (select count(*) from rb_devices where push is not null),
    'trips_active', (select count(*) from rb_trips where active),
    'trips_all', (select count(*) from rb_trips),
    'routines', (select count(*) from rb_routines),
    'routines_active', (select count(*) from rb_routines where not paused),
    'last_run', (select max(last_at) from rb_stats),
    'guard', (select coalesce(json_agg(g order by g.t desc), '[]'::json) from (select key, n, t from rb_guard where t > now() - interval '24 hours' and n > 5 order by t desc limit 20) g)
  );
$$;
revoke all on function public.rb_overview() from public, anon, authenticated;
grant execute on function public.rb_overview() to service_role;

-- Geteilte Verbindungen (kurzer Link, ohne persönliche Angaben, nach der Fahrt gelöscht)
create table if not exists public.rb_shares (
  id text primary key,
  legs jsonb not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.rb_shares enable row level security;
create index if not exists rb_shares_ends on public.rb_shares (ends_at);
alter table public.rb_shares add column if not exists routine jsonb;   -- geteilte regelmäßige Fahrt (Tage, Zeit, Fenster)
alter table public.rb_shares add column if not exists trip_id uuid;   -- Live-Link: zeigt den aktuellen Stand dieser Reise
