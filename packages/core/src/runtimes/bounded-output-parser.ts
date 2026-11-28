export interface BoundedFrameParseResult {
  frames: string[];
  oversized: boolean;
}

/**
 * Incremental marker parser whose retained state is strictly bounded.
 * Noise before START is reduced to the suffix needed for a split marker; an
 * unterminated/complete frame over maxFrameChars is discarded and reported.
 */
export class BoundedOutputFrameParser {
  private buffer = '';

  constructor(
    private readonly startMarker: string,
    private readonly endMarker: string,
    private readonly maxFrameChars: number,
  ) {
    if (!startMarker || !endMarker || maxFrameChars < 1) {
      throw new Error('Invalid bounded output parser configuration');
    }
  }

  get bufferedLength(): number {
    return this.buffer.length;
  }

  push(chunk: string): BoundedFrameParseResult {
    this.buffer += chunk;
    const frames: string[] = [];
    let oversized = false;

    while (true) {
      let startIdx = this.buffer.indexOf(this.startMarker);
      if (startIdx === -1) {
        const tailLength = Math.max(0, this.startMarker.length - 1);
        if (this.buffer.length > tailLength) {
          this.buffer = tailLength ? this.buffer.slice(-tailLength) : '';
        }
        break;
      }

      if (startIdx > 0) {
        this.buffer = this.buffer.slice(startIdx);
        startIdx = 0;
      }
      const payloadStart = this.startMarker.length;
      const endIdx = this.buffer.indexOf(this.endMarker, payloadStart);
      if (endIdx === -1) {
        // Discount only an actual suffix matching the beginning of END. This
        // supports split markers without giving arbitrary unterminated payload
        // an extra endMarker.length bytes beyond the cap.
        let partialEndLength = 0;
        const maxPartial = Math.min(
          this.endMarker.length - 1,
          this.buffer.length - payloadStart,
        );
        for (let length = maxPartial; length > 0; length--) {
          if (this.buffer.endsWith(this.endMarker.slice(0, length))) {
            partialEndLength = length;
            break;
          }
        }
        if (
          this.buffer.length - payloadStart - partialEndLength <=
          this.maxFrameChars
        ) {
          break;
        }
        oversized = true;
        // Prefer a later START (a fresh frame may follow the hostile one).
        const nextStart = this.buffer.lastIndexOf(this.startMarker);
        if (nextStart > 0) {
          this.buffer = this.buffer.slice(nextStart);
          continue;
        }
        const tailLength = Math.max(0, this.startMarker.length - 1);
        this.buffer = tailLength ? this.buffer.slice(-tailLength) : '';
        continue;
      }

      const frameLength = endIdx - payloadStart;
      if (frameLength > this.maxFrameChars) {
        oversized = true;
      } else {
        frames.push(this.buffer.slice(payloadStart, endIdx).trim());
      }
      this.buffer = this.buffer.slice(endIdx + this.endMarker.length);
    }

    return { frames, oversized };
  }
}
