ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY corex_router_ai_providers_user_scope ON public.ai_providers
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())::text)
  WITH CHECK (user_id = (SELECT auth.uid())::text);

ALTER TABLE public.router_app_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY corex_router_app_tokens_user_scope ON public.router_app_tokens
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())::text)
  WITH CHECK (user_id = (SELECT auth.uid())::text);

ALTER TABLE public.router_owner ENABLE ROW LEVEL SECURITY;
CREATE POLICY corex_router_owner_user_scope ON public.router_owner
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())::text)
  WITH CHECK (user_id = (SELECT auth.uid())::text);

ALTER TABLE public.router_provider_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY corex_router_provider_runs_user_scope ON public.router_provider_runs
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())::text)
  WITH CHECK (user_id = (SELECT auth.uid())::text);

ALTER TABLE public.router_request_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY corex_router_request_metrics_user_scope ON public.router_request_metrics
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())::text)
  WITH CHECK (user_id = (SELECT auth.uid())::text);

ALTER TABLE public.router_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY corex_router_tokens_user_scope ON public.router_tokens
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())::text)
  WITH CHECK (user_id = (SELECT auth.uid())::text);