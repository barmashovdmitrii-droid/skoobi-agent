// Moved to the @skoobi/core package (modularization wave 8d, 2026-07-07).
// The module is a pure side-effect (registers the webhook extension schema
// when WEBHOOK_SECRET is set) — importing the stub runs the package module
// once (node ESM realpath dedup). Loaded dynamically by service.ts.
import '@skoobi/core/webhook';
