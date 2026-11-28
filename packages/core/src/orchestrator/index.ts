// @skoobi/core — the orchestrator family. Consumers import concrete modules
// via subpaths ('@skoobi/core/db', '@skoobi/core/types', …) — the package
// intentionally exposes no flat barrel: the family is large and module-level
// side effects (extensions registry, watchers) must stay import-scoped.
// The bare entry re-exports only the shared type contract.
export * from './types.js';
