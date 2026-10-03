alter table public.router_ia_providers
  add column if not exists capabilities jsonb not null default '[]'::jsonb,
  add column if not exists priority integer not null default 50,
  add column if not exists model_metadata jsonb not null default '{}'::jsonb,
  add column if not exists catalog_checked_at timestamptz default now();

alter table public.router_ia_providers
  drop constraint if exists router_ia_provider_capabilities_check,
  add constraint router_ia_provider_capabilities_check
    check (
      jsonb_typeof(capabilities) = 'array'
      and capabilities <@ '[
        "chat",
        "coding",
        "reasoning",
        "summarization",
        "vision",
        "document",
        "long_context",
        "fast"
      ]'::jsonb
    ),
  drop constraint if exists router_ia_provider_priority_check,
  add constraint router_ia_provider_priority_check
    check (priority between 1 and 100),
  drop constraint if exists router_ia_provider_model_metadata_check,
  add constraint router_ia_provider_model_metadata_check
    check (jsonb_typeof(model_metadata) = 'object');

drop index if exists public.router_ia_one_active_provider;

create or replace function public.router_ia_activate_provider(provider_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.router_ia_providers
  set is_active = true, updated_at = now()
  where id = provider_id;

  if not found then
    raise exception 'Provider not found';
  end if;
end;
$$;

revoke all on function public.router_ia_activate_provider(uuid)
  from public, anon, authenticated;
grant execute on function public.router_ia_activate_provider(uuid)
  to service_role;

create or replace function public.router_ia_deactivate_provider(provider_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.router_ia_providers
  set is_active = false, updated_at = now()
  where id = provider_id;

  if not found then
    raise exception 'Provider not found';
  end if;
end;
$$;

revoke all on function public.router_ia_deactivate_provider(uuid)
  from public, anon, authenticated;
grant execute on function public.router_ia_deactivate_provider(uuid)
  to service_role;