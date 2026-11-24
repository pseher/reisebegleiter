-- Schutz vor Durchprobieren (Gerätecodes) und Massen-Registrierung
create table if not exists public.rb_guard (key text primary key, n int not null default 0, t timestamptz not null default now());
alter table public.rb_guard enable row level security;
revoke all on table public.rb_guard from anon, authenticated;
create or replace function public.rb_guard_hit(p_key text, p_sec int, p_max int)
returns boolean language plpgsql security definer set search_path = public as $$
declare cur rb_guard;
begin
  insert into rb_guard as g (key, n, t) values (p_key, 1, now())
  on conflict (key) do update set
    n = case when g.t < now() - make_interval(secs => p_sec) then 1 else g.n + 1 end,
    t = case when g.t < now() - make_interval(secs => p_sec) then now() else g.t end
  returning * into cur;
  return cur.n <= p_max;
end $$;
revoke all on function public.rb_guard_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.rb_guard_hit(text, int, int) to service_role;
