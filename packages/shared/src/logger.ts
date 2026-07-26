import pino from 'pino';

import {
  PINO_REDACT_PATHS,
  redactLogObject,
  redactString,
} from './log-sanitize.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Strip user paths and tokens from any string value in the structured log
  // object (bindings, child fields, custom fields like msg/audioPath etc.).
  // This is a defence-in-depth pass: pointed code-site fixes still apply,
  // but if a new log call accidentally drops a path/token into a string
  // field, it gets scrubbed here before stdout.
  formatters: {
    log: (obj) => redactLogObject(obj as Record<string, unknown>),
  },
  // Bonus pass for the top-level `msg` field — pino routes the second arg
  // (or template string) through messageKey, not through formatters.log.
  hooks: {
    logMethod(args, method) {
      // pino calls signatures: (msg) or (mergingObj, msg, ...interpolation)
      if (args.length >= 2 && typeof args[1] === 'string') {
        args[1] = redactString(args[1]);
      } else if (args.length >= 1 && typeof args[0] === 'string') {
        args[0] = redactString(args[0]);
      }
      return method.apply(this, args as Parameters<typeof method>);
    },
  },
  redact: {
    paths: PINO_REDACT_PATHS,
    censor: '<redacted>',
  },
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Benign/transient stream error codes. These come from writes to pipes/sockets
// that the peer closed first (EPIPE/ECONNRESET) or from a stream destroyed
// mid-flight (ERR_STREAM_PREMATURE_CLOSE) — e.g. a media-download response
// stream, a child stdin pipe, or a closed log transport. They are NOT a reason
// to take the whole process down.
const BENIGN_ERROR_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

// Route uncaught errors through pino so they get timestamps in stderr.
//
// finding #22: This is a SHARED, long-lived host process that serves EVERY
// tenant. Unconditionally calling process.exit(1) on any uncaughtException
// turns a single stray async stream error (e.g. an unguarded media-download
// 'error' event, a transient EPIPE, a throw in some event callback) into a
// GLOBAL denial of service — all tenants die at once until launchd restarts.
// Many Phase-A fixes (sandbox-runner.ts, codex-subscription-gateway.ts,
// photo-telegram.ts) exist solely to keep individual EPIPEs from reaching this
// handler; the catch-all still converted every missed case into a full outage,
// and it was inconsistent with unhandledRejection below (which only logs).
//
// For a multi-tenant service we prefer to LOG and STAY ALIVE: a single faulty
// code path should degrade one request, not the whole host. Benign stream
// codes are logged at warn (they are expected churn, not a host fault). This
// mirrors the agent-runner's handler (agent/runner/src/index.ts), which exits
// 0 on EPIPE rather than crash-looping.
process.on('uncaughtException', (err) => {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code && BENIGN_ERROR_CODES.has(code)) {
    logger.warn({ err }, 'Ignored benign uncaught stream error');
    return;
  }
  // Keep the shared host alive — log loudly instead of exiting. Process-level
  // recovery (if ever needed for a truly unrecoverable state) is the job of the
  // watchdog/launchd supervisor, not this catch-all.
  logger.fatal({ err }, 'Uncaught exception (kept process alive)');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
