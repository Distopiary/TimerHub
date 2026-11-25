-- TimerHub : schéma Supabase
-- À coller dans Supabase > SQL Editor > New query, puis "Run".
-- Le script peut être relancé sans risque.

-- ============ Membres et validation des inscriptions ============
-- Chaque compte a une ligne "membre". Tant que approved = false, le compte ne peut rien lire ni écrire.
create table if not exists public.members (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text not null,
  approved    boolean not null default false,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table public.members enable row level security;

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.approved from public.members m where m.user_id = auth.uid()), false);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.is_admin from public.members m where m.user_id = auth.uid()), false);
$$;

-- Un membre voit sa propre ligne ; l'administrateur voit tout le monde.
drop policy if exists "members_select" on public.members;
create policy "members_select" on public.members for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
grant select on public.members to authenticated;

-- Création automatique de la ligne membre à chaque inscription (en attente par défaut)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.members (user_id, username)
  values (new.id, split_part(coalesce(new.email, new.id::text), '@', 1))
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Comptes déjà existants : approuvés (une seule fois, ne change rien aux lignes existantes)
insert into public.members (user_id, username, approved)
select u.id, split_part(coalesce(u.email, u.id::text), '@', 1), true
from auth.users u
on conflict (user_id) do nothing;

-- Administrateur : Ruby
update public.members m set approved = true, is_admin = true
from auth.users u
where u.id = m.user_id and lower(u.email) = 'ruby@timerhub.local';

-- Actions d'administration (réservées aux administrateurs)
create or replace function public.admin_set_approved(target uuid, value boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if target = auth.uid() then raise exception 'Impossible de modifier ton propre compte'; end if;
  update public.members set approved = value where user_id = target and not is_admin;
end $$;

create or replace function public.admin_delete_user(target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if target = auth.uid() then raise exception 'Impossible de supprimer ton propre compte'; end if;
  if exists (select 1 from public.members where user_id = target and is_admin) then
    raise exception 'Impossible de supprimer un administrateur';
  end if;
  delete from auth.users where id = target;  -- supprime aussi ses tâches et dossiers
end $$;

revoke all on function public.admin_set_approved(uuid, boolean) from public, anon;
revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_set_approved(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
grant execute on function public.is_approved() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ============ Table des tâches ============
create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title          text not null,
  kind           text not null check (kind in ('daily', 'weekly', 'interval')),
  reset_hour     smallint not null default 0,
  reset_minute   smallint not null default 0,
  reset_weekday  smallint not null default 1,      -- 0 = dimanche, 1 = lundi, ...
  interval_minutes integer not null default 480,
  last_done_at   timestamptz,
  prev_done_at   timestamptz,                      -- pour annuler une validation
  links          jsonb not null default '[]'::jsonb,
  image_url      text,
  launch_type    text not null default 'none' check (launch_type in ('none', 'steam', 'exe', 'url')),
  launch_target  text,
  notify         boolean not null default true,
  position       integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists tasks_user_idx on public.tasks (user_id);

-- Chaque utilisateur approuvé ne voit et ne modifie que ses propres tâches
alter table public.tasks enable row level security;

drop policy if exists "tasks_select_own" on public.tasks;
drop policy if exists "tasks_insert_own" on public.tasks;
drop policy if exists "tasks_update_own" on public.tasks;
drop policy if exists "tasks_delete_own" on public.tasks;

create policy "tasks_select_own" on public.tasks for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "tasks_insert_own" on public.tasks for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "tasks_update_own" on public.tasks for update to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()))
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "tasks_delete_own" on public.tasks for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));

grant select, insert, update, delete on public.tasks to authenticated;

-- Mise à jour automatique de updated_at
create or replace function public.tasks_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.tasks_touch();

-- ============ Dossiers (onglet Rangement) ============
create table if not exists public.folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists folders_user_idx on public.folders (user_id);
alter table public.folders enable row level security;

drop policy if exists "folders_select_own" on public.folders;
drop policy if exists "folders_insert_own" on public.folders;
drop policy if exists "folders_update_own" on public.folders;
drop policy if exists "folders_delete_own" on public.folders;

create policy "folders_select_own" on public.folders for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "folders_insert_own" on public.folders for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "folders_update_own" on public.folders for update to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()))
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "folders_delete_own" on public.folders for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));

grant select, insert, update, delete on public.folders to authenticated;

drop trigger if exists folders_touch on public.folders;
create trigger folders_touch before update on public.folders
  for each row execute function public.tasks_touch();

-- Une tâche peut être rangée dans un dossier (supprimer le dossier ne supprime pas les tâches)
alter table public.tasks add column if not exists folder_id uuid references public.folders(id) on delete set null;

-- ============ Synchro temps réel PC <-> téléphone ============
do $$
declare t text;
begin
  foreach t in array array['tasks', 'folders', 'members'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============ Stockage des images ============
-- Bucket public en lecture (images de jeux), images de 2 Mo max,
-- écriture limitée au dossier de l'utilisateur approuvé.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-images', 'task-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "task_images_select_own" on storage.objects;
drop policy if exists "task_images_insert_own" on storage.objects;
drop policy if exists "task_images_update_own" on storage.objects;
drop policy if exists "task_images_delete_own" on storage.objects;

create policy "task_images_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'task-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "task_images_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'task-images' and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select public.is_approved()));
create policy "task_images_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'task-images' and (storage.foldername(name))[1] = (select auth.uid())::text
         and (select public.is_approved()));
create policy "task_images_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'task-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
