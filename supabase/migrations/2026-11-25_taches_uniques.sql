-- Migration : tâches uniques (rendez-vous). Déjà incluse dans schema.sql.
alter table public.tasks add column if not exists due_at timestamptz;
alter table public.tasks add column if not exists duration_minutes integer not null default 0;
alter table public.tasks drop constraint if exists tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check check (kind in ('daily', 'weekly', 'interval', 'once'));
