import { PROVIDER_CAPABILITIES } from "./provider-adapter.mjs";

export function buildCapabilityRoutes(providers) {
  return PROVIDER_CAPABILITIES.map((capability) => ({
    capability,
    providers: providers
      .filter(
        (provider) =>
          provider.active === true &&
          Array.isArray(provider.capabilities) &&
          provider.capabilities.includes(capability),
      )
      .sort(
        (first, second) =>
          second.priority - first.priority ||
          first.name.localeCompare(second.name),
      )
      .map((provider) => ({
        id: provider.id,
        provider: provider.provider,
        name: provider.name,
        model: provider.model,
        priority: provider.priority,
      })),
  }));
}