create table public.workspace_snapshots (
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_key text not null check (workspace_key in ('builder-projects', 'python-projects')),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_key)
);

alter table public.workspace_snapshots enable row level security;

revoke all on table public.workspace_snapshots from anon, public;
grant select, insert, update, delete on table public.workspace_snapshots to authenticated;

create policy "Users can access their own workspace snapshots"
  on public.workspace_snapshots
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);