import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as providers from './index.js';

// r1111 (SEC-09): ImageGateway был мёртвым кодом — экземпляр нигде не
// создавался, message-loop прямо запрещает этот путь, рисование идёт через
// codex_builtin. При этом по умолчанию он был включён и смотрел на сторонний
// image.pollinations.ai: подключи его кто-нибудь снова — запросы
// пользователей ушли бы на чужой сервис. Модуль удалён; тест не даёт ему
// вернуться незаметно.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('@skoobi/providers без ImageGateway', () => {
  it('не экспортирует ImageGateway и его настройки', () => {
    const names = Object.keys(providers);
    expect(names).toContain('loadModelGatewayConfig');
    expect(names.filter((name) => /image/i.test(name))).toEqual([]);
  });

  it('пример настроек не предлагает сторонний pollinations.ai', () => {
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(example).not.toMatch(/pollinations/i);
    expect(example).not.toMatch(/^\s*#?\s*SKOOBI_IMAGE_GENERATION_/m);
  });
});
