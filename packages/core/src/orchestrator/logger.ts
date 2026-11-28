// Moved to the @skoobi/shared package (modularization wave 0, 2026-07-07).
// This stub keeps the ~150 existing `./orchestrator/logger.js` imports working
// without a repo-wide rewrite. New code should import from '@skoobi/shared'.
// NB: importing this module still installs the process-level
// uncaughtException/unhandledRejection keep-alive handlers (side effect lives
// in the package module, evaluated once).
export * from '@skoobi/shared/logger';
