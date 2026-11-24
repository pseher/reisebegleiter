-- Reisebegleiter: mehrere Geräte teilen dieselben Reisen und Favoriten (Konto ohne Anmeldung, Verbinden per Code)
create table if not exists public.rb_accounts (
  id          uuid primary key default gen_random_uuid(),
  favs        jsonb not null default '[]',          -- gespeicherte Lieblingsverbindungen
  created_at  timestamptz not null default now()
);
alter table public.rb_accounts enable row level security;
revoke all on public.rb_accounts from anon, authenticated;

alter table public.rb_devices add column if not exists account_id uuid references public.rb_accounts(id) on delete cascade;
alter table public.rb_devices add column if not exists label      text;          -- „Android-Handy“, „iPhone“, „Windows-PC“ …
alter table public.rb_devices add column if not exists link_code  text;          -- SHA-256 des gerade gültigen Verbindungscodes
alter table public.rb_devices add column if not exists link_until timestamptz;
alter table public.rb_devices add column if not exists link_tries jsonb;          -- Fehlversuche beim Code-Eingeben (Schutz vor Raten)
create index if not exists rb_devices_account_idx on public.rb_devices (account_id);
create index if not exists rb_devices_link_idx on public.rb_devices (link_code) where link_code is not null;

alter table public.rb_trips add column if not exists account_id uuid references public.rb_accounts(id) on delete cascade;
create index if not exists rb_trips_account_idx on public.rb_trips (account_id);
-- Reisen gehören dem Konto; das anlegende Gerät darf verschwinden, ohne die Reise mitzunehmen
alter table public.rb_trips alter column device_id drop not null;
alter table public.rb_trips drop constraint if exists rb_trips_device_id_fkey;
alter table public.rb_trips add constraint rb_trips_device_id_fkey foreign key (device_id) references public.rb_devices(id) on delete set null;

-- Bestand: jedes Gerät bekommt sein eigenes Konto (gleiche ID), Reisen wandern mit
insert into public.rb_accounts (id) select d.id from public.rb_devices d where d.account_id is null on conflict (id) do nothing;
update public.rb_devices set account_id = id where account_id is null;
update public.rb_trips set account_id = device_id where account_id is null and device_id is not null;
