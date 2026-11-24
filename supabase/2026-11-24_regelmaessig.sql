-- Reisebegleiter: regelmäßige Fahrten (z. B. Arbeit hin Mo–Fr 07:40). Jeden Fahrtag wird ca. 3 Std. vorher eine Reise angelegt.
create table if not exists public.rb_routines (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.rb_accounts(id) on delete cascade,
  name        text not null,
  days        jsonb not null default '[1,2,3,4,5]',   -- Wochentage 1 = Mo … 7 = So
  dep         text not null,                          -- Abfahrt (Ortszeit Berlin) „07:40“
  tpl         jsonb not null,                         -- Teilstrecken als Vorlage
  ticket      text not null default 'flex',
  min_t       int  not null default 0,
  holidays    boolean not null default true,          -- an Feiertagen (Berlin) pausieren
  paused      boolean not null default false,
  skip        jsonb not null default '[]',            -- einzelne Tage aussetzen „2026-12-01“
  made        jsonb not null default '[]',            -- Tage, für die schon eine Reise angelegt wurde
  created_at  timestamptz not null default now()
);
create index if not exists rb_routines_account_idx on public.rb_routines (account_id);
alter table public.rb_routines enable row level security;
revoke all on public.rb_routines from anon, authenticated;

-- Zeitfenster („zwischen 07:00 und 08:00“): alle Fahrten im Fenster beobachten
alter table public.rb_routines add column if not exists win_from text;
alter table public.rb_routines add column if not exists win_to text;
