import { describe, expect, it } from 'vitest';

import { BoundedOutputFrameParser } from './bounded-output-parser.js';

const START = '---START---';
const END = '---END---';

describe('BoundedOutputFrameParser', () => {
  it('parses a normal frame split across multiple chunks', () => {
    const parser = new BoundedOutputFrameParser(START, END, 128);
    expect(parser.push(`noise${START.slice(0, 5)}`).frames).toEqual([]);
    expect(parser.push(`${START.slice(5)}{"ok":`).frames).toEqual([]);
    const result = parser.push(`true}${END}tail`);
    expect(result).toEqual({ frames: ['{"ok":true}'], oversized: false });
    expect(parser.bufferedLength).toBeLessThan(START.length);
  });

  it('bounds an oversized unterminated frame and reports it', () => {
    const parser = new BoundedOutputFrameParser(START, END, 64);
    expect(parser.push(`${START}${'x'.repeat(40)}`).oversized).toBe(false);
    const result = parser.push('y'.repeat(40));
    expect(result.oversized).toBe(true);
    expect(result.frames).toEqual([]);
    expect(parser.bufferedLength).toBeLessThanOrEqual(START.length - 1);

    for (let i = 0; i < 100; i++) parser.push('z'.repeat(100));
    expect(parser.bufferedLength).toBeLessThanOrEqual(START.length - 1);
  });

  it('drops an oversized complete frame but can parse a later valid frame', () => {
    const parser = new BoundedOutputFrameParser(START, END, 32);
    const result = parser.push(
      `${START}${'x'.repeat(33)}${END}${START}{"ok":1}${END}`,
    );
    expect(result.oversized).toBe(true);
    expect(result.frames).toEqual(['{"ok":1}']);
    expect(parser.bufferedLength).toBe(0);
  });

  it('accepts an exactly max-sized frame when END is split across chunks', () => {
    const parser = new BoundedOutputFrameParser(START, END, 32);
    const payload = 'x'.repeat(32);
    expect(parser.push(`${START}${payload}${END.slice(0, 3)}`).oversized).toBe(
      false,
    );
    expect(parser.push(END.slice(3))).toEqual({
      frames: [payload],
      oversized: false,
    });
  });
});
