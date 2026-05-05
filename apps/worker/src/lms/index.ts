// Public entry-point for the LMS substrate. Concrete provider modules
// (canvas, blackboard, ...) live as siblings under this directory; the
// reconciliation engine and HTTP routes import the interface, registry,
// and the singleton from here.

export type { LmsProvider } from "./provider.js";
export { LmsProviderRegistry, lmsProviderRegistry } from "./registry.js";
