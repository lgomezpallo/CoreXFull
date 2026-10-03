create table if not exists public.router_ia_providers (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('groq', 'openai', 'openrouter', 'custom')),
  name text not null check (char_length(name) between 1 and 80),
  base_url text not null check (base_url like 'https://%'),
  model text not null check (char_length(model) between 1 and 200),
  api_key_ciphertext text not null,
  api_key_iv text not null,
  api_key_tag text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists router_ia_one_active_provider
  on public.router_ia_providers (is_active)
  where is_active is true;

alter table public.router_ia_providers enable row level security;
revoke all on table public.router_ia_providers from anon, authenticated;
grant select, insert, update, delete on table public.router_ia_providers to service_role;

create or replace function public.router_ia_activate_provider(provider_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.router_ia_providers
    where id = provider_id
  ) then
    raise exception 'Provider not found';
  end if;

  update public.router_ia_providers
  set is_active = false, updated_at = now()
  where is_active is true;

  update public.router_ia_providers
  set is_active = true, updated_at = now()
  where id = provider_id;
end;
$$;

revoke all on function public.router_ia_activate_provider(uuid) from public, anon, authenticated;
grant execute on function public.router_ia_activate_provider(uuid) to service_role;

create or replace function public.router_ia_add_provider(
  p_provider text,
  p_name text,
  p_base_url text,
  p_model text,
  p_api_key_ciphertext text,
  p_api_key_iv text,
  p_api_key_tag text
)
returns table (
  id uuid,
  provider text,
  name text,
  base_url text,
  model text,
  is_active boolean,
  created_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  new_provider_id uuid;
begin
  update public.router_ia_providers
  set is_active = false, updated_at = now()
  where is_active is true;

  insert into public.router_ia_providers (
    provider,
    name,
    base_url,
    model,
    api_key_ciphertext,
    api_key_iv,
    api_key_tag,
    is_active
  )
  values (
    p_provider,
    p_name,
    p_base_url,
    p_model,
    p_api_key_ciphertext,
    p_api_key_iv,
    p_api_key_tag,
    true
  )
  returning public.router_ia_providers.id into new_provider_id;

  return query
  select
    saved.id,
    saved.provider,
    saved.name,
    saved.base_url,
    saved.model,
    saved.is_active,
    saved.created_at
  from public.router_ia_providers as saved
  where saved.id = new_provider_id;
end;
$$;

revoke all on function public.router_ia_add_provider(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.router_ia_add_provider(text, text, text, text, text, text, text)
  to service_role;