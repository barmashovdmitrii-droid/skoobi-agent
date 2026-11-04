/** One quiet, editable progress message per chat turn. Final replies stay separate. */
const RETENTION_MS = 2 * 60 * 60 * 1000;
const MAX_RETAINED_TURNS = 256;

export class ProgressMessages {
  private entries = new Map<string, { messageId: number; text: string; at: number }>();
  private chains = new Map<string, Promise<boolean>>();
  private controllers = new Map<string, AbortController>();
  private closed = new Map<string, number>();

  private prune(now: number): void {
    for (const [key, value] of this.entries) {
      if (now - value.at > RETENTION_MS && !this.chains.has(key)) this.entries.delete(key);
    }
    for (const [key, at] of this.closed) {
      if (now - at > RETENTION_MS && !this.chains.has(key)) this.closed.delete(key);
    }
    for (const map of [this.entries, this.closed]) {
      for (const key of map.keys()) {
        if (map.size <= MAX_RETAINED_TURNS) break;
        if (!this.chains.has(key)) map.delete(key);
      }
    }
  }

  async update(input: {
    chat: string;
    turn: string;
    text: string;
    send: (text: string, signal: AbortSignal) => Promise<number>;
    edit: (id: number, text: string, signal: AbortSignal) => Promise<void>;
    now?: number;
  }): Promise<boolean> {
    const key = `${input.chat}\0${input.turn}`;
    this.prune(input.now ?? Date.now());
    if (this.closed.has(key)) return false;
    const controller = this.controllers.get(key) ?? new AbortController();
    this.controllers.set(key, controller);
    const work = (this.chains.get(key) ?? Promise.resolve(true))
      .catch(() => false)
      .then(async () => {
        if (controller.signal.aborted || this.closed.has(key)) return false;
        const now = input.now ?? Date.now();
        const existing = this.entries.get(key);
        if (existing?.text === input.text) return true;
        let creatingMessage = false;
        try {
          if (existing) {
            try {
              await input.edit(existing.messageId, input.text, controller.signal);
            } catch (error) {
              if (controller.signal.aborted) return false;
              const description = String((error as { description?: string })?.description ?? '');
              if (!/message is not modified/i.test(description)) {
                // Only a definite missing/uneditable message allows replacement.
                // A transport failure has an unknown outcome, so never duplicate it.
                if (!/message to edit not found|message can.t be edited/i.test(description)) throw error;
                creatingMessage = true;
                const messageId = await input.send(input.text, controller.signal);
                if (controller.signal.aborted) return false;
                this.entries.set(key, { messageId, text: input.text, at: now });
                return true;
              }
            }
            if (controller.signal.aborted) return false;
            this.entries.set(key, { ...existing, text: input.text, at: now });
          } else {
            creatingMessage = true;
            const messageId = await input.send(input.text, controller.signal);
            if (controller.signal.aborted) return false;
            this.entries.set(key, { messageId, text: input.text, at: now });
          }
          return true;
        } catch (error) {
          if (controller.signal.aborted) return false;
          if (creatingMessage) {
            // The send may have reached Telegram without returning its id.
            // Retrying a new status in this turn could create another message.
            this.closed.set(key, now);
            controller.abort();
          }
          throw error;
        }
      });
    this.chains.set(key, work);
    try {
      return await work;
    } finally {
      if (this.chains.get(key) === work) {
        this.chains.delete(key);
        this.controllers.delete(key);
      }
      this.prune(input.now ?? Date.now());
    }
  }

  /** Close only this turn. The transport must honor abort and have its own timeout. */
  async finish(chat: string, turn: string, now = Date.now()): Promise<void> {
    const key = `${chat}\0${turn}`;
    this.closed.set(key, now);
    this.controllers.get(key)?.abort();
    // Wait for an in-flight transport to settle before the separate final send.
    // Queued updates share the aborted controller and cannot create a late status.
    await this.chains.get(key)?.catch(() => false);
    this.entries.delete(key);
    this.prune(now);
  }
}
