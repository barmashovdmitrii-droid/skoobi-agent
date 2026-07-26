/**
 * Serialises Baileys credential writes and fail-closes once any write fails.
 * A reconnect must drain this barrier before a new auth state is opened.
 */
export class CredentialSaveBarrier {
  private tail: Promise<void> = Promise.resolve();
  private firstFailure: unknown;

  enqueue(operation: () => Promise<void>): Promise<void> {
    const attempt = this.tail.then(operation);
    this.tail = attempt.catch((error: unknown) => {
      if (this.firstFailure === undefined) this.firstFailure = error;
    });
    return attempt;
  }

  async drain(): Promise<void> {
    // Await until the queue is stable. This also covers an operation enqueued
    // while an earlier credential write was still settling.
    for (;;) {
      const observedTail = this.tail;
      await observedTail;
      if (observedTail === this.tail) break;
    }
    if (this.firstFailure !== undefined) {
      throw new Error('WhatsApp credential save failed', {
        cause: this.firstFailure,
      });
    }
  }
}

/**
 * Keeps at most one 515 reconnect transition active and invalidates callbacks
 * belonging to superseded sockets.
 */
export class AuthReconnectGate {
  private generation = 0;
  private reconnecting = false;

  beginSocket(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  async reconnectAfterCredentialSave(
    generation: number,
    drainCredentials: () => Promise<void>,
    reconnect: () => Promise<void>,
  ): Promise<boolean> {
    if (!this.isCurrent(generation) || this.reconnecting) return false;
    this.reconnecting = true;
    try {
      await drainCredentials();
      if (!this.isCurrent(generation)) return false;
      await reconnect();
      return true;
    } finally {
      this.reconnecting = false;
    }
  }
}
