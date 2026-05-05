// LMS provider registry (sub-issue UNI-51).
//
// Single lookup table from `LmsProviderId` to a concrete `LmsProvider`.
// Sub-issue UNI-51 ships the substrate empty — sub-issue UNI-52
// registers Canvas, Phase-3 sub-issues register the rest.
//
// `register` is idempotent on the registry instance: a second call with
// the same id replaces the prior implementation. Tests use this to swap
// in a fake without leaking across cases (`new LmsProviderRegistry()`).

import type { LmsProviderId } from "@university-hub/shared";

import type { LmsProvider } from "./provider.js";

export class LmsProviderRegistry {
  private readonly providers = new Map<LmsProviderId, LmsProvider>();

  register(provider: LmsProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Returns the registered implementation, or `undefined` if the
   *  provider id is known to the type but not yet wired in this build.
   *  Routes that depend on a missing provider should surface a 503 or a
   *  configuration error rather than crashing. */
  get(id: LmsProviderId): LmsProvider | undefined {
    return this.providers.get(id);
  }

  /** Throws when the provider isn't registered. Use from code paths
   *  that have already validated (via the schema CHECK + a
   *  `lms_provider_configs.enabled = 1` row) that the provider should
   *  exist in this build. */
  require(id: LmsProviderId): LmsProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`LMS provider '${id}' is not registered.`);
    }
    return provider;
  }

  /** Snapshot of registered ids. The set order is insertion order. */
  ids(): LmsProviderId[] {
    return Array.from(this.providers.keys());
  }
}

/**
 * Process-wide registry. Sub-issue UNI-51 leaves it empty; UNI-52
 * imports this module from Canvas's entry-point and registers the
 * Canvas implementation as a side-effect of import. Wiring concrete
 * providers from a single place keeps test isolation simple — tests
 * that exercise reconciliation can build their own
 * `new LmsProviderRegistry()` and stay off the global.
 */
export const lmsProviderRegistry = new LmsProviderRegistry();
