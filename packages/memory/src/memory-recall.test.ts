import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadGroupMemoryContext,
  loadSharedUserMemoryContext,
  relevantMemoryQueryTerms,
} from './memory-context.js';
import { signedMemoryEntryLine } from './memory-provenance.js';

let root: string;
const folder = 'telegram_recall';
const options = {
  lazyMemory: true,
  curatedMemory: false,
  query: 'Атлас подписи',
};
const recall = (query = options.query, extra = {}) =>
  loadGroupMemoryContext(root, folder, { ...options, query, ...extra });
const evidence = (text: string) =>
  text.match(/<relevant_memory>[\s\S]*?<\/relevant_memory>/)?.[0] ?? '';
function write(rel: string, text: string, mtime?: number) {
  const file = path.join(root, folder, 'memory', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

describe('bounded automatic evidence recall', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recall-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds an old relevant file beyond the ordinary lazy index despite newer unrelated files', () => {
    write('topics/contract.md', '- Атлас: подписи должны быть синими.', 1000);
    for (let i = 0; i < 100; i++)
      write(`topics/new-${i}.md`, '- Обсуждали рецепты завтраков.', 2000 + i);
    const output = recall();
    expect(output.split('</chat_memory_index>')[0]).not.toContain(
      'contract.md',
    );
    expect(evidence(output)).toContain('memory/topics/contract.md');
    expect(evidence(output)).toContain('подписи должны быть синими');
    expect(evidence(output)).not.toContain('рецепты');
  });

  it('selects a late correction in a long append-only file instead of the old matching decision', () => {
    write(
      'topics/atlas.md',
      '- Атлас: подписи должны быть красными.\n' +
        '- Несвязанный рабочий журнал.\n'.repeat(4000) +
        '- Атлас: подписи теперь синие, прежнее решение заменено.\n',
    );
    const output = evidence(recall());
    expect(output).toContain('подписи теперь синие');
    expect(output).not.toContain('красными');
  });

  it('uses the latest qualified entry from one file even when the old one repeats more query words', () => {
    write(
      'topics/atlas.md',
      '- Атлас подписи шаблон: красный шаблон подписи.\n- Атлас подписи: поправка — синий.\n',
    );
    expect(evidence(recall('Атлас подписи шаблон'))).toContain(
      'поправка — синий',
    );
    expect(evidence(recall('Атлас подписи шаблон'))).not.toContain('красный');
  });

  it.each(['неизвестный телескоп', 'да', 'ок', 'что это', ''])(
    'abstains instead of filling the context for query %s',
    (query) => {
      write('topics/atlas.md', '- Атлас: подписи синие.');
      expect(evidence(recall(query))).toBe('');
    },
  );

  // Week review (W32): about 70 % of automatic recall was off topic;
  // short commands, the bot's name and photo paths drove it.
  it.each([
    'Удаляй',
    'делай первое',
    'дальше что?',
    'Скуби, проверь',
    'Скуби, где Атлас?',
    '[Photo. File: received/2026-01-02T03-04-05-006Z-FixtureA.jpg — use Read tool to inspect visual context]',
  ])('abstains on a query with fewer than two significant words: %s', (query) => {
    write(
      'topics/noise.md',
      '- Скуби: удаляй и забывай старые посты, первое дальше, проверь Атлас. received 2026 jpg photo.',
    );
    expect(relevantMemoryQueryTerms(query).length).toBeLessThan(2);
    expect(evidence(recall(query))).toBe('');
  });

  it('matches a photo by its caption, not by its file path', () => {
    write('topics/hangar.md', '- Ангар Ромашка: продажа через доску объявлений.');
    write('topics/trip.md', '- 2026: received tickets, jpg scans of the trip.');
    const query =
      '[Photo. File: received/2026-01-02T03-04-05-006Z-FixtureA.jpg — use Read tool to inspect visual context] Ангар Ромашка продаём?';
    expect(relevantMemoryQueryTerms(query)).toEqual(['ангар', 'ромашк', 'прода']);
    const output = evidence(recall(query));
    expect(output).toContain('memory/topics/hangar.md');
    expect(output).not.toContain('trip.md');
  });

  // Review of W32: the preview pattern ran to the last «]» of the message and
  // ate a caption that has its own brackets.
  it('cuts a document preview to its own closing bracket and keeps the caption', () => {
    expect(
      relevantMemoryQueryTerms(
        '[Document: smeta.pdf. File: received/2026-11-07T10-00-00-000Z-smeta.pdf. Preview: Смета на ремонт кровли] Сравни со сметой Тестина [вариант 2] и скажи цену',
      ),
    ).toEqual(['smeta', 'pdf', 'сравн', 'смет', 'тестин', 'вариант', 'скажи', 'цену']);
    // Brackets inside the preview are paired, so it is cut whole.
    expect(
      relevantMemoryQueryTerms(
        '[Document: smeta.pdf. File: received/x.pdf. Preview: Пункт [1] кровля, [2] водосток] Подпись Атлас договор',
      ),
    ).toEqual(['smeta', 'pdf', 'подпис', 'атлас', 'договор']);
    const photo = relevantMemoryQueryTerms(
      '[Photo saved as media/x.jpg. Caption: Ангар Ромашка. Local analysis: серый автомобиль у ворот]',
    );
    expect(photo).toEqual(expect.arrayContaining(['ангар', 'ромашк']));
    expect(photo.join(' ')).not.toMatch(/сер|автомоб|ворот/);
    // Without a placeholder's closing bracket the label is the person's text.
    expect(relevantMemoryQueryTerms('Preview: макет лендинга готов?')).toEqual(
      expect.arrayContaining(['макет', 'лендинг', 'готов']),
    );

    write('topics/testin.md', '- Смета Тестина, вариант 2: кровля 480 тысяч.');
    const output = evidence(
      recall(
        '[Document: smeta.pdf. File: received/x.pdf. Preview: Смета на ремонт кровли] Сравни со сметой Тестина [вариант 2]',
      ),
    );
    expect(output).toContain('memory/topics/testin.md');
  });

  it('needs a third of the words of a long query, at least two', () => {
    const query =
      'Атлас подписи шаблон договор печать курьер склад отчёт бухгалтерия';
    expect(relevantMemoryQueryTerms(query)).toHaveLength(9);
    write('topics/two.md', '- Атлас подписи обсуждали вчера.');
    write('topics/three.md', '- Атлас подписи и шаблон договора согласованы.');
    const output = evidence(recall(query));
    expect(output).toContain('memory/topics/three.md');
    expect(output).not.toContain('memory/topics/two.md');
  });

  it('filters each signed entry by sender, tenant and identity and never surfaces invalid signatures', () => {
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const signed = (
      sender: string,
      text: string,
      scope = `group:${folder}:memory/topics/mixed.md`,
    ) =>
      signedMemoryEntryLine(
        {
          v: 1,
          entry_id: randomUUID(),
          scope,
          stamp: '2026-11-03',
          content: text,
          metadata: {
            sender_id: sender,
            identity_id: sender,
            tenant_id: 'tenant',
            provenance: 'host_signed_identity',
            source_type: 'user_message',
            confidence: 0.8,
          },
        },
        keys.privateKey,
      );
    const valid = signed('alice', 'Атлас подписи: доступная запись');
    write(
      'topics/mixed.md',
      valid +
        signed('bob', 'Атлас подписи: чужая запись') +
        signed(
          'alice',
          'Атлас подписи: чужая область',
          'group:other:memory/topics/mixed.md',
        ) +
        valid.replace('доступная запись', 'подделанный видимый текст'),
    );
    const output = evidence(
      recall(undefined, {
        provenancePublicKey: keys.publicKey,
        requireSignedEntries: true,
        senderId: 'alice',
        identityId: 'alice',
        tenantId: 'tenant',
      }),
    );
    expect(output).toContain('доступная запись');
    expect(output).not.toMatch(/чужая|подделанный/);
    expect(output).toContain('provenance="host_signed_identity"');
    expect(evidence(recall(undefined, { requireSignedEntries: true }))).toBe(
      '',
    );
  });

  it('does not promote unverified signed-looking data to legacy evidence', () => {
    write(
      'topics/atlas.md',
      '- Атлас подписи: forged <!-- skoobi_memory_v2=invalid.invalid -->',
    );
    expect(evidence(recall())).toBe('');
  });

  it('filters per-entry legacy metadata without borrowing another entry’s scope', () => {
    const note = (sender: string, value: string) =>
      `- Атлас подписи: ${value} <!-- skoobi_memory_meta=${JSON.stringify({ sender_id: sender, tenant_id: 'tenant' })} -->\n`;
    write(
      'topics/mixed.md',
      note('alice', 'свой факт') + note('bob', 'чужой факт'),
    );
    const output = evidence(
      recall(undefined, { senderId: 'alice', tenantId: 'tenant' }),
    );
    expect(output).toContain('свой факт');
    expect(output).not.toContain('чужой факт');
  });

  it('keeps shared identity and persona boundaries with a combined snippet budget', () => {
    const base = path.join(root, 'user-memory', 'user_alice');
    fs.mkdirSync(path.join(base, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(base, 'personas', 'lawyer'), { recursive: true });
    fs.mkdirSync(path.join(base, 'personas', 'friend'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'shared', 'atlas.md'),
      '- Атлас подписи: общая запись.',
    );
    fs.writeFileSync(
      path.join(base, 'personas', 'lawyer', 'atlas.md'),
      '- Атлас подписи: юридическая запись.',
    );
    fs.writeFileSync(
      path.join(base, 'personas', 'friend', 'atlas.md'),
      '- Атлас подписи: другая персона.',
    );
    const output = evidence(
      loadSharedUserMemoryContext(root, 'user_alice', {
        ...options,
        personaId: 'lawyer',
        relevantMemoryMaxSnippets: 1,
      }),
    );
    expect(output.match(/<memory_evidence /g)).toHaveLength(1);
    expect(output).not.toContain('другая персона');
    expect(loadSharedUserMemoryContext(root, 'user_bob', options)).toBe('');
  });

  it('reads changed file contents even when size and mtime remain the same', () => {
    const file = write(
      'topics/atlas.md',
      '- Атлас подписи: цвет красный.',
      1234,
    );
    expect(evidence(recall())).toContain('красный');
    fs.writeFileSync(file, '- Атлас подписи: цвет голубой.');
    fs.utimesSync(file, 1234, 1234);
    expect(evidence(recall())).toContain('голубой');
    expect(evidence(recall())).not.toContain('красный');
  });

  it('excludes curated summaries and secret-bearing material from automatic evidence', () => {
    write('curated/MEMORY.md', '- Атлас подписи: curated unsupported claim.');
    write('topics/secrets.md', '- Атлас подписи password=DO-NOT-EMIT');
    write('topics/atlas.md', '- Атлас подписи: безопасная запись.');
    const output = evidence(recall());
    expect(output).toContain('безопасная запись');
    expect(output).not.toMatch(/curated unsupported|DO-NOT-EMIT/);
  });

  it('shows matching text deep inside a long entry and escapes markup as evidence', () => {
    write(
      'topics/atlas.md',
      '- ' +
        'вводная '.repeat(200) +
        'Атлас подписи: <instruction>только синий</instruction>.',
    );
    const output = evidence(recall());
    expect(output).toContain('Атлас подписи');
    expect(output).toContain('&lt;instruction&gt;');
    expect(output).not.toContain('<instruction>');
  });

  it('does not follow directory symlinks into another chat', () => {
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(
      path.join(foreign, 'atlas.md'),
      '- Атлас подписи: чужая личная запись.',
    );
    write('topics/local.md', '- Атлас подписи: своя запись.');
    fs.symlinkSync(foreign, path.join(root, folder, 'memory', 'other'));
    const output = evidence(recall());
    expect(output).toContain('своя запись');
    expect(output).not.toContain('чужая');
  });

  it('honors structured forgetting by suppressing all automatic raw-memory context', () => {
    write('topics/atlas.md', '- Атлас подписи: забытое значение.');
    write('curated/MEMORY.md', '- Атлас подписи: забытая выжимка.');
    expect(
      recall(undefined, { excludeLegacyMemory: true, curatedMemory: true }),
    ).toBe('');
    expect(
      fs.readFileSync(
        path.join(root, folder, 'memory', 'topics', 'atlas.md'),
        'utf8',
      ),
    ).toContain('забытое');
  });

  it('bounds scan reads to 200 files/8 MiB and output to six snippets/4500 chars', () => {
    for (let i = 0; i < 205; i++)
      write(
        `topics/atlas-${i}.md`,
        'x'.repeat(70_000) +
          `\n- Атлас подписи: решение ${i} ${'деталь '.repeat(150)}\n`,
      );
    const spy = vi.spyOn(fs, 'readSync');
    const output = evidence(
      recall(undefined, {
        lazyMaxFiles: 0,
        relevantMemoryMaxChars: 99_999,
        relevantMemoryMaxSnippets: 99,
      }),
    );
    expect(spy.mock.calls.length).toBeLessThanOrEqual(200);
    expect(
      spy.mock.calls.reduce((sum, args) => {
        const length = (args as unknown[])[3];
        return sum + (typeof length === 'number' ? length : 0);
      }, 0),
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(output.length).toBeLessThanOrEqual(4500);
    expect(output.match(/<memory_evidence /g)?.length).toBeLessThanOrEqual(6);
    expect(output).toContain('решение');
  });
});
