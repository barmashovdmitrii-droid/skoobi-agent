import pino from 'pino';

import {
  PINO_REDACT_PATHS,
  redactLogObject,
  redactString,
} from '../lib/log-sanitize.js';

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

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
