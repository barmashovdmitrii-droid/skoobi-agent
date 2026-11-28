/**
 * ClaudeClaw Service — Background orchestrator entry point.
 * Run by launchd (macOS) or systemd (Linux) as a persistent service.
 *
 * This is the process that polls for messages, spawns agents, and routes responses.
 * Start with: node dist/service.js
 * Dev mode:   npx tsx src/service.ts
 *
 * The working directory IS the instance — all state (store/, groups/, .env)
 * lives in cwd. Multiple instances = multiple directories.
 */
import { loadExtensions } from './orchestrator/extension-loader.js';
import { initServiceLifecycle } from './orchestrator/service-lifecycle.js';

async function start(): Promise<void> {
  // Record start/stop reasons before anything else can fail, so that a crash
  // during startup still leaves a trace distinguishing it from a deploy.
  initServiceLifecycle();

  // Load enabled built-in channels (self-registering on import).
  await import('./channels/index.js');

  // Load built-in extensions (always present in core)
  await import('@skoobi/core/run-telemetry');
  await import('./webhook/index.js');

  // Load installable extensions from extensions/ directory
  await loadExtensions();

  // Start the orchestrator
  const { main } = await import('./orchestrator/message-loop.js');
  await main();
}

start().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
