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
        "transcription",
        "speech",
        "image_generation",
        "image_editing",
        "long_context",
        "fast"
      ]'::jsonb
    );

update public.router_ia_providers
set capabilities = (
  select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
  from (
    select distinct on (value) value, ord
    from jsonb_array_elements_text(
      case
        when model_metadata->'inputModalities' ? 'audio'
          and (
            model_metadata->'outputModalities' ? 'transcription'
            or model_metadata->'outputModalities' ? 'text'
          )
          then capabilities || '["transcription"]'::jsonb
        else capabilities
      end
      || case
        when model_metadata->'inputModalities' ? 'text'
          and (
            model_metadata->'outputModalities' ? 'speech'
            or model_metadata->'outputModalities' ? 'audio'
          )
          then '["speech"]'::jsonb
        else '[]'::jsonb
      end
      || case
        when model_metadata->'inputModalities' ? 'text'
          and model_metadata->'outputModalities' ? 'image'
          then '["image_generation"]'::jsonb
        else '[]'::jsonb
      end
      || case
        when model_metadata->'inputModalities' ? 'image'
          and model_metadata->'outputModalities' ? 'image'
          then '["image_editing"]'::jsonb
        else '[]'::jsonb
      end
    ) with ordinality as expanded(value, ord)
    order by value, ord
  ) deduped
)
where is_active = true;
