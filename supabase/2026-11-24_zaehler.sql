-- Abfragezähler je Stunde (nur für den Betreiber sichtbar, über /admin.html mit ADMIN_KEY)
create table if not exists public.rb_stats (
  hour timestamptz primary key,
  db int not null default 0, db429 int not null default 0, vbb int not null default 0, motis int not null default 0, ai int not null default 0,
  runs int not null default 0, checks int not null default 0, trips_max int not null default 0, db_max_run int not null default 0
);
alter table public.rb_stats enable row level security;
create or replace function public.rb_stats_add(p_hour timestamptz, p_db int, p_db429 int, p_vbb int, p_motis int, p_ai int, p_runs int, p_checks int, p_trips int)
returns void language sql security definer set search_path = public as $$
  insert into rb_stats as s (hour, db, db429, vbb, motis, ai, runs, checks, trips_max, db_max_run)
  values (p_hour, p_db, p_db429, p_vbb, p_motis, p_ai, p_runs, p_checks, p_trips, case when p_runs > 0 then p_db else 0 end)
  on conflict (hour) do update set db = s.db + excluded.db, db429 = s.db429 + excluded.db429, vbb = s.vbb + excluded.vbb,
    motis = s.motis + excluded.motis, ai = s.ai + excluded.ai, runs = s.runs + excluded.runs, checks = s.checks + excluded.checks,
    trips_max = greatest(s.trips_max, excluded.trips_max), db_max_run = greatest(s.db_max_run, excluded.db_max_run);
$$;
revoke all on function public.rb_stats_add(timestamptz, int, int, int, int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.rb_stats_add(timestamptz, int, int, int, int, int, int, int, int) to service_role;
revoke all on table public.rb_stats from anon, authenticated;
