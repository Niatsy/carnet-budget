-- À coller une seule fois dans Supabase > SQL Editor > New query, puis « Run ».
-- Crée la table où le carnet range tes données, avec une règle : chacun ne voit que les siennes.

create table if not exists public.items (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  kind       text        not null check (kind in ('profile', 'tx')),
  data       jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists items_user_updated on public.items (user_id, updated_at);

-- L'heure de mise à jour vient du serveur : c'est elle qui permet aux appareils de savoir quoi récupérer.
create or replace function public.items_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
for each row execute function public.items_touch();

-- Sécurité : chaque personne connectée ne lit et n'écrit que ses propres lignes.
alter table public.items enable row level security;

drop policy if exists "items_select_own" on public.items;
drop policy if exists "items_insert_own" on public.items;
drop policy if exists "items_update_own" on public.items;
drop policy if exists "items_delete_own" on public.items;
create policy "items_select_own" on public.items for select to authenticated using (user_id = auth.uid());
create policy "items_insert_own" on public.items for insert to authenticated with check (user_id = auth.uid());
create policy "items_update_own" on public.items for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "items_delete_own" on public.items for delete to authenticated using (user_id = auth.uid());
