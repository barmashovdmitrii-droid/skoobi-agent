/**
 * W41: health of Telegram long polling, as seen from inside the process.
 *
 * grammY retries a failed getUpdates on its own every 3 s and only logs it
 * through its `debug` channel, which is off in prod. Once the network was
 * gone for 2.5 h: the journal showed plain silence and the heartbeat kept
 * writing `telegram: true`, because the channel object was still "connected".
 *
 * This tracker sits in the API transformer chain and watches every getUpdates
 * call: the first failure after a success is logged, a problem older than the
 * stall threshold is logged once more and makes the channel unhealthy for the
 * heartbeat, and the recovery is logged with the outage length. A getUpdates
 * that neither returns nor fails (half-open TCP) counts too, once it has been
 * in flight longer than the long-poll timeout plus the threshold.
 *
 * Startup counts as well: until grammY's onStart fires (getMe and
 * deleteWebhook, retried by grammY with a pause that grows to 20 min) no
 * getUpdates runs at all, so a boot without network used to look healthy.
 * The tracker now treats the time since connect() began as a problem until
 * onStart, and logs a failed getMe/deleteWebhook like a failed getUpdates.
 *
 * isConnected() is deliberately left alone: outbound delivery keeps trying on
 * its own terms; only the heartbeat (and thus the deadman) learns the truth.
 */

export const DEFAULT_TELEGRAM_POLL_STALL_SEC = 300;
/** grammY's default long-poll timeout (seconds) — a healthy call returns within it. */
const LONG_POLL_TIMEOUT_MS = 30_000;
/** Calls grammY makes in bot.start() before onStart (withRetries, up to 20 min apart). */
const STARTUP_METHODS: ReadonlySet<string> = new Set(['getMe', 'deleteWebhook']);

type PollLog = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export interface TelegramPollHealthOptions {
  log: PollLog;
  /** Stall threshold in seconds; read on every check. 0 disables the verdict. */
  stallSec: () => number;
  describeError?: (err: unknown) => unknown;
  now?: () => number;
}

export interface TelegramPollHealthStatus {
  healthy: boolean;
  /** Seconds since the current problem began (failure streak or hung call). */
  problemSec: number | null;
  consecutiveFailures: number;
}

export class TelegramPollHealth {
  private failingSince: number | null = null;
  private consecutiveFailures = 0;
  private inFlightSince: number | null = null;
  /** connect() began and grammY's onStart has not fired yet. */
  private startingSince: number | null = null;
  private stallLogged = false;
  private readonly now: () => number;

  constructor(private readonly opts: TelegramPollHealthOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** connect() began: inbound is not up until onStartupComplete(). */
  onStartupBegin(): void {
    this.startingSince = this.now();
  }

  /** grammY's onStart fired: getMe and deleteWebhook went through. */
  onStartupComplete(): void {
    if (this.startingSince === null) return;
    this.onSuccess();
  }

  isStarting(): boolean {
    return this.startingSince !== null;
  }

  onRequestStart(): void {
    this.inFlightSince = this.now();
  }

  /** A getUpdates aborted by bot.stop() is a shutdown, not a failure. */
  onRequestCancelled(): void {
    this.inFlightSince = null;
  }

  onSuccess(): void {
    const since = this.problemSince();
    const wasDown = this.failingSince !== null || this.stallLogged;
    this.inFlightSince = null;
    this.startingSince = null;
    if (wasDown && since !== null) {
      const downSec = Math.round((this.now() - since) / 1000);
      this.opts.log.info(
        { downSec, failures: this.consecutiveFailures },
        'Telegram polling recovered',
      );
    }
    this.failingSince = null;
    this.consecutiveFailures = 0;
    this.stallLogged = false;
  }

  onFailure(err: unknown, method = 'getUpdates'): void {
    const startedAt = this.inFlightSince;
    this.inFlightSince = null;
    this.consecutiveFailures += 1;
    if (this.failingSince === null) {
      const now = this.now();
      // A call that hung before failing (half-open TCP: it only errors at the
      // 180 s client timeout) became a problem once it outlived the long
      // poll, not when it finally failed — the same point the hung-call
      // branch counts from, so the alarm and downSec are not ~3 min late.
      this.failingSince =
        startedAt === null
          ? now
          : Math.min(now, startedAt + LONG_POLL_TIMEOUT_MS);
      this.opts.log.warn(
        {
          ...(method === 'getUpdates' ? {} : { method }),
          err: this.describe(err),
        },
        `Telegram polling failed (${method}); grammY keeps retrying`,
      );
    }
    this.checkStall(err);
  }

  status(): TelegramPollHealthStatus {
    this.checkStall();
    const problemSince = this.problemSince();
    const problemSec =
      problemSince === null
        ? null
        : Math.max(0, Math.round((this.now() - problemSince) / 1000));
    return {
      healthy: !this.isStalled(),
      problemSec,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private describe(err: unknown): unknown {
    if (this.opts.describeError) return this.opts.describeError(err);
    return err instanceof Error ? err.message : String(err);
  }

  private stallMs(): number {
    let sec: number;
    try {
      sec = Number(this.opts.stallSec());
    } catch {
      sec = DEFAULT_TELEGRAM_POLL_STALL_SEC;
    }
    if (!Number.isFinite(sec) || sec < 0) sec = DEFAULT_TELEGRAM_POLL_STALL_SEC;
    return sec * 1000;
  }

  /**
   * Start of the current problem: startup not finished, a failure streak, or
   * a call hung past the long poll — whichever began first.
   */
  private problemSince(): number | null {
    const candidates: number[] = [];
    if (this.startingSince !== null) candidates.push(this.startingSince);
    if (this.failingSince !== null) candidates.push(this.failingSince);
    if (
      this.inFlightSince !== null &&
      this.now() - this.inFlightSince > LONG_POLL_TIMEOUT_MS
    ) {
      candidates.push(this.inFlightSince + LONG_POLL_TIMEOUT_MS);
    }
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  private isStalled(): boolean {
    const stallMs = this.stallMs();
    if (stallMs === 0) return false;
    const since = this.problemSince();
    return since !== null && this.now() - since >= stallMs;
  }

  private checkStall(err?: unknown): void {
    if (this.stallLogged || !this.isStalled()) return;
    this.stallLogged = true;
    const since = this.problemSince();
    this.opts.log.error(
      {
        problemSec:
          since === null ? null : Math.round((this.now() - since) / 1000),
        failures: this.consecutiveFailures,
        hung: this.failingSince === null && this.startingSince === null,
        starting: this.startingSince !== null,
        ...(err === undefined ? {} : { err: this.describe(err) }),
      },
      'Telegram polling has not worked past the stall threshold; heartbeat marks telegram unhealthy',
    );
  }
}

type ApiCall = (
  method: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * grammY API transformer that feeds getUpdates outcomes into the tracker,
 * and the failures of getMe/deleteWebhook while the bot is still starting.
 * Every other method passes through untouched.
 */
export function pollHealthTransformer(health: TelegramPollHealth) {
  return async (
    prev: ApiCall,
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (method !== 'getUpdates') {
      if (!STARTUP_METHODS.has(method) || !health.isStarting()) {
        return prev(method, payload, signal);
      }
      // Startup: only failures are recorded here; success is onStart's call.
      try {
        const result = await prev(method, payload, signal);
        const failure = errorReply(result);
        if (failure) health.onFailure(failure, method);
        return result;
      } catch (err) {
        if (!signal?.aborted) health.onFailure(err, method);
        throw err;
      }
    }
    health.onRequestStart();
    try {
      const result = await prev(method, payload, signal);
      const failure = errorReply(result);
      if (failure) health.onFailure(failure);
      else health.onSuccess();
      return result;
    } catch (err) {
      if (signal?.aborted) health.onRequestCancelled();
      else health.onFailure(err);
      throw err;
    }
  };
}

/**
 * Transformers see the raw Bot API response: an error reply (502 from
 * Telegram, 429, 409 …) comes back as { ok: false }, it is not thrown.
 */
function errorReply(result: unknown): Error | null {
  const response = result as
    | { ok?: unknown; error_code?: unknown; description?: unknown }
    | null
    | undefined;
  if (response && typeof response === 'object' && response.ok === false) {
    return new Error(
      `Bot API ${String(response.error_code ?? '?')}: ${String(response.description ?? '')}`,
    );
  }
  return null;
}
