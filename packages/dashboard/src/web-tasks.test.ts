import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// web/app.js — браузерный IIFE без сборки, в vitest не импортируется; проверка
// по исходнику: обе кнопки строки задачи отключены для одного и того же
// набора статусов (previously: «▶️ сейчас» у отменённой задачи была
// активна и отвечала «включи кнопкой ▶», которая уже отключена).
const appJs = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/app.js'),
  'utf8',
);

function taskButton(act: 'pause' | 'run'): string {
  const match = appJs.match(
    new RegExp(`<button data-act="${act}"[^>]*>`, 'u'),
  );
  if (!match) throw new Error(`task button ${act} not found in app.js`);
  return match[0];
}

describe('панель: кнопки строки задачи', () => {
  it('«▶️ сейчас» отключена для completed/cancelled так же, как ⏸/▶', () => {
    const guard =
      "${t.statusRaw === 'completed' || t.statusRaw === 'cancelled' ? 'disabled' : ''}";
    expect(taskButton('pause')).toContain(guard);
    expect(taskButton('run')).toContain(guard);
  });
});
