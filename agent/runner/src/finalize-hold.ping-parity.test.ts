/**
 * W09: the runner's ping list must be the host's list. The runner is built on
 * its own and cannot import message-loop.ts, so its copy fell five phrases
 * behind («ну как ты», «почему молчишь», …) and a ready answer stayed held on
 * a plain «ну как ты». This test reads the host literal from the source.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { PING_RE, isPingMessage, isStatusQuestion } from './finalize-hold.js';

const hostSource = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../packages/core/src/orchestrator/message-loop.ts',
  ),
  'utf8',
);

describe('ping list: runner = host', () => {
  it('the same regular expression, phrase for phrase', () => {
    const match = hostSource.match(
      /export const ACTIVE_RUN_PING_PATTERN =\s*\/(.+)\/(\w*);/u,
    );
    expect(match, 'host ACTIVE_RUN_PING_PATTERN literal not found').not.toBeNull();
    expect(PING_RE.source).toBe(match![1]);
    expect(PING_RE.flags).toBe(match![2]);
  });

  it.each(['Ну как ты', 'Почему молчишь?', 'Как продвигается?', 'Ты продолжаешь?', 'Делается?', 'Делает?'])(
    'ping: %s',
    (text) => {
      expect(isPingMessage(text)).toBe(true);
    },
  );

  it.each(['Что дальше', 'дальше что?', 'готово'])('not a ping: %s', (text) => {
    expect(isPingMessage(text)).toBe(false);
  });

  it('«А сейчас» is a status question: the ready answer goes, the question stays', () => {
    expect(isPingMessage('А сейчас')).toBe(false);
    expect(isStatusQuestion('А сейчас')).toBe(true);
    expect(isStatusQuestion('А сейчас что?')).toBe(true);
    expect(isStatusQuestion('А сейчас поменяй цвет')).toBe(false);
  });
});
