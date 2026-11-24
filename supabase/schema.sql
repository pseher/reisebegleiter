-- Reisebegleiter – Tabellen im PlanFlink-Projekt (Präfix rb_)
-- Zugriff nur über den Worker mit dem Secret Key. Keine Policies = die App im Browser kommt nicht direkt heran.
-- Einmal im Supabase SQL Editor ausführen. Ändert nichts an den PlanFlink-Tabellen.

create table if not exists public.rb_devices (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null,                       -- SHA-256 des Geräte-Schlüssels, der Schlüssel selbst bleibt auf dem Gerät
  push        jsonb,                               -- Web-Push-Abo dieses Geräts
  usage       jsonb,                               -- Tageszähler für den KI-Import
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create table if not exists public.rb_trips (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references public.rb_devices(id) on delete cascade,
  ticket      text not null default 'flex',        -- spar | flex | dticket | bc100
  legs        jsonb not null,                      -- Teilstrecken (Zug, ab, an, Sollzeiten, Gleise)
  obs         jsonb not null default '[]',         -- letzte Echtzeit-Beobachtung je Teilstrecke
  state       jsonb not null default '{}',         -- bestätigter Status, gesendete Meldungen, Plan B
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  ends_at     timestamptz                          -- geplante Ankunft am Ziel; 24 Std. danach wird gelöscht
);

create index if not exists rb_trips_active_idx on public.rb_trips (active) where active;
create index if not exists rb_trips_device_idx on public.rb_trips (device_id);

alter table public.rb_devices enable row level security;
alter table public.rb_trips   enable row level security;
revoke all on public.rb_devices from anon, authenticated;
revoke all on public.rb_trips   from anon, authenticated;

-- Nachtrag (für bestehende Tabellen): Tageszähler für den KI-Import
alter table public.rb_devices add column if not exists usage jsonb;

-- Nachtrag 24.11.2026: Konten zum Verbinden mehrerer Geräte → siehe supabase/2026-11-24_konten.sql
