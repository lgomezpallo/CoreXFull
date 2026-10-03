create table if not exists public.router_ia_admin_passkeys (
  credential_id text primary key
    check (char_length(credential_id) between 1 and 1024),
  credential_public_key text not null
    check (char_length(credential_public_key) between 1 and 16384),
  sign_count bigint not null default 0
    check (sign_count >= 0),
  transports text[] not null default '{}',
  name text not null default 'Dispositivo'
    check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

alter table public.router_ia_admin_passkeys enable row level security;
revoke all on table public.router_ia_admin_passkeys from anon, authenticated;
grant select, insert, update, delete
  on table public.router_ia_admin_passkeys to service_role;