-- Tageslimit fürs Einlesen mit KI je Gerät
alter table public.rb_devices add column if not exists usage jsonb;
