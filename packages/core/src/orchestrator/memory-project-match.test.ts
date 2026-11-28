import { ownerReadNameSource } from '../../test/read-name-message.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRecalledStructuredMemoryContext, promptMemoryListing } from './memory-prompt-recall.js';
import {
  ensureMemoryStateSchema,
  listMemoryState,
  getMemoryProject,
  mutateMemoryState,
  searchMemoryState,
  type MemoryProjectCard,
} from './memory-state-store.js';
import { buildStructuredMemoryContext } from './memory-state-context.js';

const scope = {
  chatJid: 'tg:100',
  tenantId: 'fixture-tenant',
  identityId: 'fixture-user',
};
const identity = {
  identity_id: scope.identityId,
  telegram_message_origin: 'direct',
  telegram_user_id: '100',
  chat_id: '100',
};
const input = {
  chatJid: scope.chatJid,
  senderId: '100',
  tenant: { tenant_id: scope.tenantId },
  senderIdentity: identity,
};
const start = '2031-02-10T07:00:00.000Z';
const later = '2031-02-11T07:00:00.000Z';
const oldFormat = (title: string): MemoryProjectCard => ({
  title,
  goal: 'Review the fixture',
  status: 'active',
  pending: [],
  completed: [],
  waiting: null,
  artifacts: [],
});

describe('scoped project names through normal prompt and manual reads', () => {
  let db: Database.Database;
  let n: number;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureMemoryStateSchema(db);
    n = 0;
  });
  afterEach(() => db.close());
  const storeCard = (
    projectKey: string,
    card: MemoryProjectCard,
    rev = 0,
    direct = true,
    now = start,
    focusQuote = card.title,
  ) => {
    const existing = getMemoryProject(db, scope, projectKey)?.project.card;
    const changes: string[] = [];
    for (const name of (card.aliases ?? []).filter(n => !existing?.aliases?.includes(n))) changes.push(`Добавь имя «${name}» проекту ${projectKey}`);
    for (const name of (existing?.aliases ?? []).filter(n => card.aliases && !card.aliases.includes(n))) changes.push(`Удали имя «${name}» у проекта ${projectKey}`);
    for (const key of (card.relatedProjectKeys ?? []).filter(n => !existing?.relatedProjectKeys?.includes(n))) changes.push(`Свяжи проект ${projectKey} с проектом ${key}`);
    for (const key of (existing?.relatedProjectKeys ?? []).filter(n => card.relatedProjectKeys && !card.relatedProjectKeys.includes(n))) changes.push(`Убери связь проекта ${projectKey} с проектом ${key}`);
    const consent = changes.join("\n");
    return mutateMemoryState(
      db,
      scope,
      {
        kind: 'project_upsert',
        projectKey,
        card,
        expectedRevision: rev,
        operationId: 'fixture-card-' + ++n,
      },
      direct
        ? {
            kind: 'direct_user',
            at: now,
            messageId: String(n),
            quote: consent || focusQuote,
            ...(consent ? ownerReadNameSource(db,scope,String(n),now,consent) : {}),
            currentDirectInput: true,
          }
        : { kind: 'assistant_report', at: now },
      { now },
    );
  };
  const storeFact = (projectKey: string, value: string, now = start) =>
    mutateMemoryState(
      db,
      scope,
      {
        kind: 'fact_upsert',
        projectKey,
        key: 'decision',
        value,
        factType: 'decision',
        expectedRevision: 0,
        operationId: 'fixture-fact-' + ++n,
      },
      { kind: 'direct_user', at: now, messageId: String(n), quote: value },
      { now },
    );
  const prompt = (currentText: string, now = start) =>
    buildRecalledStructuredMemoryContext(
      db,
      { ...input, currentText },
      { now: () => now },
    );
  const search = (query: string, projectKey?: string) =>
    searchMemoryState(db, scope, { query, projectKey, now: start }).results;

  it('keeps the comma inside a complete stored title or approved alias', async () => {
    const title = 'Утренняя сверка Amber Valley после переноса CRM, 17 апреля';
    const alias = 'Сверка архива, апрель';
    storeCard('archive-a', { ...oldFormat(title), aliases: [alias] });
    storeFact('archive-a', 'fixture-confirmed-archive');
    for (const query of [title, title.replace(',', ''), `Статус проекта «${title}»?`, alias]) {
      expect((await prompt(query)).context).toContain('fixture-confirmed-archive');
      expect(search(query).some(r => r.projectKey === 'archive-a')).toBe(true);
    }
    for (const query of ['17 апреля', 'Переведи фразу «' + title + '»', 'Не вспоминай ' + title]) {
      expect((await prompt(query)).context).not.toContain('fixture-confirmed-archive');
    }
  });

  it('keeps external commas, exclusions, competing titles and the original clause limit', async () => {
    const title = 'Сверка Amber Valley, апрель';
    storeCard('archive-a', oldFormat(title));
    storeCard('marble-b', oldFormat('Marble ledger'));
    storeFact('archive-a', 'fixture-archive');
    storeFact('marble-b', 'fixture-marble');
    const query = await prompt(`Статус ${title}, исключи Marble ledger`);
    expect(query.context).toContain('fixture-archive');
    expect(query.context).not.toContain('fixture-marble');
    expect((await prompt(`Статус Marble ledger, исключи ${title}`)).context).not.toContain('fixture-archive');
    expect((await prompt(`Статус ${title}, статус Marble ledger`)).context).toContain('ambiguous_projects');
    expect((await prompt('Marble, ledger')).stats?.projectSelected).toBe(false);
    expect((await prompt(title + ', уточнение'.repeat(15))).stats?.projectSelected).toBe(false);
    storeCard('archive-b', oldFormat(title));
    const duplicate = await prompt(title);
    expect(duplicate.context).toContain('ambiguous_projects');
    expect(duplicate.context).not.toContain('fixture-archive');
  });

  it('keeps successive bare names in an exclusion list until a new request', async () => {
    const title = 'Статус сверки Amber Valley, апрель';
    storeCard('archive-a', oldFormat(title));
    storeCard('marble-b', oldFormat('Marble ledger'));
    storeCard('cobalt-c', oldFormat('Cobalt ledger'));
    storeFact('archive-a', 'fixture-archive');
    storeFact('marble-b', 'fixture-marble');
    storeFact('cobalt-c', 'fixture-cobalt');
    expect((await prompt('Не про Marble ledger, а про Cobalt ledger: когда начнём?')).context)
      .toContain('fixture-cobalt');
    expect((await prompt('Ничего в Marble ledger не меняй, только скажи текущий статус.')).context)
      .toContain('fixture-marble');
    for (const name of [title, `«${title}»`, `и ${title}`, `а также ${title}`, `\n${title}`]) {
      for (const instruction of ['Исключи', 'Не меняй']) {
        const excluded = await prompt(`${instruction} Marble ledger, ${name}`);
        expect(excluded.stats?.projectSelected).toBe(false);
        expect(excluded.context).not.toContain('ambiguous_projects');
      }
      const read = await prompt(`Исключи Marble ledger, ${name}, что с Cobalt ledger?`);
      expect(read.context).toContain('fixture-cobalt');
      expect(read.context).not.toContain('fixture-archive');
      expect(read.context).not.toContain('fixture-marble');
    }
  });

  it('recognizes a short marketplace name in both scripts and an exact host on legacy cards', async () => {
    storeCard('partner-intake', oldFormat('Подключение LMX для партнёров'));
    storeCard(
      'registry-refresh',
      oldFormat('Обновление mosaic.example для подрядчиков'),
    );
    storeFact('partner-intake', 'fixture-market-decision');
    storeFact('registry-refresh', 'fixture-domain-decision');
    for (const q of [
      'Что решили по LMX?',
      'Что с доступом ЛМХ?',
      'Подключение LMX для партнёров',
    ]) {
      expect((await prompt(q)).context).toContain('fixture-market-decision');
      expect(
        search(q).some(
          (row) => row.kind === 'fact' && row.projectKey === 'partner-intake',
        ),
      ).toBe(true);
    }
    expect((await prompt('Как дела с mosaic.example?')).context).toContain(
      'fixture-domain-decision',
    );
    for (const q of [
      'чужой.other-mosaic.example',
      'not.mosaic.example',
      'пример другого API',
      'ЛМХА',
      'LMXYZ',
    ]) {
      expect((await prompt(q)).stats?.projectSelected).toBe(false);
    }
  });

  it('matches a legacy product title and a distinguishing word in either order', async () => {
    storeCard(
      'delivery-board',
      oldFormat('Сайт для веломастеров учебной службы'),
    );
    storeFact('delivery-board', 'fixture-board');
    storeCard('reader-hub', oldFormat('Сайт для читателей научной службы'));
    storeFact('reader-hub', 'fixture-reader');
    for (const q of [
      'сайт для веломастеров',
      'Для веломастеров: что с сайтом?',
    ]) {
      const response = await prompt(q);
      expect(response.context).toContain('fixture-board');
      expect(response.context).not.toContain('fixture-reader');
    }
    for (const q of [
      'Что с сайтом?',
      'Сайт для библиотекарей',
      'API проекта',
    ]) {
      expect((await prompt(q)).stats?.projectSelected).toBe(false);
    }
    storeCard(
      'another-board',
      oldFormat('Сайт для веломастеров вечерней смены'),
    );
    const competing = await prompt('Что с сайтом для веломастеров?');
    expect(competing.stats?.projectSelected).toBe(false);
    expect(competing.context).toContain('ambiguous_projects');
    expect(competing.context).not.toContain('fixture-board');
  });

  it('supports declared conversational names and only one hop of explicit history', async () => {
    storeCard('prior-draft', oldFormat('Черновик архива'));
    storeFact('prior-draft', 'fixture-two-hops');
    storeCard('desk-archive', {
      ...oldFormat('Предыдущая схема'),
      status: 'completed',
      relatedProjectKeys: ['prior-draft'],
    });
    storeFact('desk-archive', 'fixture-previous-decision');
    storeCard('desk-v2', {
      ...oldFormat('Голосовой помощник Миры'),
      aliases: ['номер Миры', 'линия оператора'],
      relatedProjectKeys: ['desk-archive'],
    });
    storeFact('desk-v2', 'fixture-current-decision');
    storeCard('contractor-site', {
      ...oldFormat('Новый кабинет исполнителя'),
      aliases: ['сайт для подрядчиков'],
    });
    storeFact('contractor-site', 'fixture-site-decision');
    for (const q of [
      'Что с номером Миры?',
      'Расскажи про голосового помощника Миры',
      'Линия оператора',
    ]) {
      const text = (await prompt(q)).context;
      expect(text).toContain('fixture-current-decision');
      expect(text).toContain('fixture-previous-decision');
      expect(text).toContain('related_history');
      expect(text).not.toContain('fixture-two-hops');
    }
    expect((await prompt('Что с сайтом для подрядчиков?')).context).toContain(
      'fixture-site-decision',
    );
    expect(
      search('номер Миры').some(
        (row) => row.relatedHistory && row.projectKey === 'desk-archive',
      ),
    ).toBe(true);
    expect(
      search('номер Миры', 'desk-v2').every(
        (row) => row.projectKey === 'desk-v2',
      ),
    ).toBe(true);
    const before = listMemoryState(db, scope);
    await prompt('Линия оператора');
    expect(listMemoryState(db, scope)).toEqual(before);
  });

  it('lists colliding card names only, with no writes, arbitrary winner or selection from truncated candidates', async () => {
    storeCard('catalog-a', {
      ...oldFormat('Первый каталог'),
      aliases: ['LMX'],
    });
    storeCard('catalog-b', {
      ...oldFormat('Второй каталог'),
      aliases: ['LMX'],
    });
    storeFact('catalog-a', 'fixture-first');
    storeFact('catalog-b', 'fixture-second');
    const before = listMemoryState(db, scope);
    const result = await prompt('Запускай ЛМХ');
    expect(result.stats?.projectSelected).toBe(false);
    expect(result.context).toContain('ambiguous_projects');
    expect(result.context).not.toContain('fixture-first');
    expect(result.context).not.toContain('fixture-second');
    expect(search('ЛМХ').map((r) => r.kind)).toEqual(['project', 'project']);
    expect(listMemoryState(db, scope)).toEqual(before);
    const page = listMemoryState(db, scope, { limit: 1 });
    expect(
      buildStructuredMemoryContext(page, 'ЛМХ').selectedProjectKey,
    ).toBeNull();
    expect(buildStructuredMemoryContext(page, 'ЛМХ').context).toContain(
      'moreProjectsAvailable',
    );
  });

  it('abstains when recent project writes lack a verifiable assignment or the project is inactive', async () => {
    const doc = oldFormat('Архив таблиц');
    storeCard('ledger', doc);
    storeCard('other', oldFormat('Другой кабинет'), 0, false, start);
    expect((await prompt('продолжай')).stats?.projectSelected).toBe(false);
    storeCard(
      'ledger',
      { ...doc, pending: ['Добавлен отчёт'] },
      1,
      false,
      later,
    );
    expect((await prompt('продолжай', later)).stats?.projectSelected).toBe(
      false,
    );
    storeCard(
      'ledger',
      { ...doc, status: 'waiting', waiting: 'Получить ответ' },
      2,
      true,
      later,
    );
    expect((await prompt('продолжай', later)).stats?.projectSelected).toBe(
      false,
    );
    storeCard('ledger', { ...doc, status: 'cancelled' }, 3, true, later);
    expect((await prompt('продолжай', later)).stats?.projectSelected).toBe(
      false,
    );
    expect((await prompt('Архив таблиц', later)).context).toContain(
      'cancelled',
    );
    expect(
      listMemoryState(db, scope).projects.find((p) => p.projectKey === 'ledger')
        ?.card.status,
    ).toBe('cancelled');
  });

  it('never resolves a write or activation by short name, partial key or historical link', () => {
    const doc = oldFormat('Проверка канала');
    storeCard('channel-verification', {
      ...doc,
      status: 'cancelled',
      aliases: ['LMX'],
    });
    storeCard('current-work', {
      ...oldFormat('Текущая проверка'),
      relatedProjectKeys: ['channel-verification'],
    });
    const before = listMemoryState(db, scope);
    for (const name of ['LMX', 'channel-verif']) {
      expect(() => storeFact(name, 'fixture-no-write')).toThrow(
        'project_missing',
      );
      expect(() =>
        mutateMemoryState(
          db,
          scope,
          {
            kind: 'project_activate',
            projectKey: name,
            expectedRevision: 0,
            operationId: 'blocked-activate-' + ++n,
          },
          {
            kind: 'direct_user',
            at: start,
            messageId: String(n),
            quote: name,
            explicitActivate: true,
          },
          { now: start },
        ),
      ).toThrow('project_missing');
    }
    expect(() =>
      storeCard(
        'current-work',
        { ...doc, relatedProjectKeys: ['channel-verif'] },
        1,
      ),
    ).toThrow('related_project_missing');
    expect(listMemoryState(db, scope)).toEqual(before);
  });

  it('does not resurrect a forgotten name or its decisions after reopening and explicitly remembering a new version', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-name-fixture-'));
    const filename = path.join(dir, 'state.db');
    db.close();
    db = new Database(filename);
    try {
      ensureMemoryStateSchema(db);
      storeCard('project-record', {
        ...oldFormat('Архив приборов'),
        aliases: ['киоск наблюдения'],
      });
      storeFact('project-record', 'fixture-purged-value');
      storeCard('primary', {
        ...oldFormat('Хранилище осмотров'),
        relatedProjectKeys: ['project-record'],
      });
      mutateMemoryState(
        db,
        scope,
        {
          kind: 'forget',
          target: 'project',
          projectKey: 'project-record',
          operationId: 'fixture-forget-record',
          expectedRevision: 1,
        },
        {
          kind: 'direct_user',
          at: later,
          messageId: String(++n),
          quote: 'Забыть архив',
          explicitForget: true,
        },
        { now: later },
      );
      db.close();
      db = new Database(filename);
      expect(
        (await prompt('киоск наблюдения', later)).stats?.projectSelected,
      ).toBe(false);
      expect((await prompt('Хранилище осмотров', later)).context).not.toContain(
        'fixture-purged-value',
      );
      expect(search('киоск наблюдения')).toHaveLength(0);
      const next = '2031-02-13T07:00:00.000Z';
      mutateMemoryState(
        db,
        scope,
        {
          kind: 'project_upsert',
          projectKey: 'project-record',
          operationId: 'fixture-remember-record',
          expectedRevision: 2,
          card: {
            ...oldFormat('Альбом образцов'),
            status: 'completed',
            aliases: ['полка образцов'],
          },
        },
        {
          ...ownerReadNameSource(db,scope,String(++n),next,'Добавь имя «полка образцов» проекту project-record'),
          explicitRemember: true,
        },
        { now: next },
      );
      expect(
        (await prompt('киоск наблюдения', next)).stats?.projectSelected,
      ).toBe(false);
      const fresh = await prompt('полка образцов', next);
      expect(fresh.context).toContain('Альбом образцов');
      expect(fresh.context).not.toContain('fixture-purged-value');
      expect(fresh.context).not.toContain('киоск наблюдения');
      expect((await prompt('Хранилище осмотров', next)).context).not.toContain(
        'fixture-purged-value',
      );
    } finally {
      db.close();
      db = new Database(':memory:');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reaches old full names beyond the prompt page and keeps independently mentioned projects', async () => {
    storeCard('front-desk', {
      ...oldFormat('LMX Северный пост'),
      aliases: ['LMX'],
    });
    storeFact('front-desk', 'fixture-north');
    storeCard('south-desk', {
      ...oldFormat('LMX Южный пост'),
      aliases: ['LMX'],
    });
    storeFact('south-desk', 'fixture-south');
    for (let i = 0; i < 210; i++)
      storeCard('other-' + i, oldFormat('Блок ' + i), 0, false, later);
    // Clear the selected old key out of the 200-card page, too.
    storeCard('current-desk', oldFormat('Текущая цель'), 0, true, later);
    const bounded = listMemoryState(db, scope, { limit: 200, now: later });
    expect(bounded.projectsTruncated).toBe(true);
    expect(bounded.projects.some((p) => p.projectKey === 'front-desk')).toBe(
      false,
    );
    for (const q of ['Что с LMX Северный пост?', 'Что с front-desk?']) {
      const result = await prompt(q, later);
      expect(result.context).toContain('fixture-north');
      expect(result.context).not.toContain('fixture-south');
    }
    for (const q of [
      'Что с LMX?',
      'LMX Северный пост и LMX Южный пост?',
      'LMX Северный пост и отдельно ЛМХ?',
    ]) {
      const result = await prompt(q, later);
      expect(result.stats?.projectSelected).toBe(false);
      expect(result.context).toContain('ambiguous_projects');
      expect(result.context).not.toContain('fixture-north');
    }
    expect(
      search('Что с LMX Северный пост?', undefined).some(
        (p) => p.kind === 'fact' && p.projectKey === 'front-desk',
      ),
    ).toBe(true);
  });

  it('reads current decisions from the selected project and its explicit history beyond a full fact page', async () => {
    const query = 'Лазурная полка';
    storeCard('earlier-pattern', {
      ...oldFormat('Чертежи основания'),
      status: 'completed',
    });
    storeFact('earlier-pattern', 'fixture-historical-dimension');
    storeCard('current-pattern', {
      ...oldFormat('Изготовление образца'),
      aliases: [query],
      relatedProjectKeys: ['earlier-pattern'],
    });
    storeFact('current-pattern', 'fixture-current-dimension');
    for (let i = 0; i < 220; i++) {
      const projectKey = 'unrelated-' + i;
      storeCard(projectKey, oldFormat('Станция ' + i), 0, false, later);
      storeFact(projectKey, 'fixture-unrelated-dimension-' + i, later);
    }
    storeCard('latest-focus', oldFormat('Последнее поручение'), 0, true, later);
    const firstPage = listMemoryState(db, scope, { limit: 200, now: later });
    expect(firstPage.facts).toHaveLength(200);
    expect(firstPage.facts.every(f => f.projectKey?.startsWith('unrelated-'))).toBe(true);
    expect(firstPage.projects.some(p => p.projectKey === 'current-pattern')).toBe(false);

    const recalled = await prompt(query, later);
    expect(recalled.mode).toBe('lexical');
    expect(recalled.stats?.injectedFacts).toBe(2);
    const synchronous = buildStructuredMemoryContext(
      promptMemoryListing(db, scope, { ...input, currentText: query }, later), query, { now: later },
    );
    for (const context of [recalled.context, synchronous.context]) {
      expect(context).toContain('fixture-current-dimension');
      expect(context).toContain('fixture-historical-dimension');
      expect(context).toContain('relatedHistory');
      expect(context).not.toContain('fixture-unrelated-dimension');
      expect(context.length).toBeLessThanOrEqual(6500);
    }
    expect(search(query).filter(hit => hit.kind === 'fact').map(hit => hit.projectKey)).toEqual([
      'current-pattern', 'earlier-pattern',
    ]);
    storeCard('second-pattern', { ...oldFormat('Другое изделие'), aliases: [query] }, 0, true, later);
    const ambiguous = await prompt(query, later);
    expect(ambiguous.stats?.projectSelected).toBe(false);
    expect(ambiguous.stats?.injectedFacts).toBe(0);
  });

  it('keeps broad keyword search for generic terms and narrows explicit names to their projects', async () => {
    storeCard('market-intake', {
      ...oldFormat('LMX Северный пост'),
      aliases: ['сайт'],
    });
    storeCard('office-intake', oldFormat('LMX Южный пост'));
    storeFact('market-intake', 'fixture-site-north сайт');
    storeFact('office-intake', 'fixture-site-south сайт');
    expect((await prompt('сайт')).stats?.projectSelected).toBe(false);
    expect(
      search('сайт')
        .map((r) => r.projectKey)
        .sort(),
    ).toEqual(['market-intake', 'office-intake']);
    expect(
      search('LMX Северный пост').every(
        (r) => r.projectKey === 'market-intake',
      ),
    ).toBe(true);
    expect(
      search('сайт', 'office-intake').every(
        (r) => r.projectKey === 'office-intake',
      ),
    ).toBe(true);
    expect(
      searchMemoryState(db, scope, {
        query: 'сайт',
        projectKey: null,
        now: start,
      }).results,
    ).toHaveLength(0);
  });

  it('applies requested exclusions to manual reads, linked history, global preferences and file context', async () => {
    storeCard('old-board', oldFormat('Площадка DRT для отдела'));
    storeFact('old-board','history-marker');
    storeCard('new-board',{...oldFormat('Новый портал по заявкам'),relatedProjectKeys:['old-board']});
    storeFact('new-board','current-marker');
    mutateMemoryState(db,scope,{kind:'fact_upsert',key:'habit',projectKey:null,value:'global-marker DRT',factType:'preference',operationId:'habit',expectedRevision:0},
      {kind:'direct_user',at:start,messageId:'899',quote:'Учебная запись'},{now:start});
    for (const query of ['Только новый портал по заявкам','Новый портал по заявкам, без DRT']) {
      const visible = await prompt(query);
      expect(visible.context).toContain('current-marker');
      expect(visible.context).not.toContain('history-marker');
      expect(visible.context).not.toContain('global-marker');
      expect(visible.excludeLegacyMemory).toBe(true);
      expect(visible.recallQuery).toBe('');
      expect(search(query).every(item => item.projectKey === 'new-board')).toBe(true);
    }
    const excluded = await prompt('Переведи строку «DRT»');
    expect(excluded.context).not.toContain('marker');
    expect(excluded.excludeLegacyMemory).toBe(true);
    expect(search('Не включай DRT')).toEqual([]);
    expect(search('Не включай DRT','old-board')).toEqual([]);
  });

  it('retains early restrictions when long messages end with a plausible lookup', async () => {
    storeCard('demo',oldFormat('Учебная система QVX для архива'));
    storeFact('demo','restricted-marker');
    for (const prefix of ['Не вспоминай QVX. ', 'Помоги с фразой «', "Translate the quotation '", 'Она сказала “']) {
      const output = await prompt(prefix + 'подробности '.repeat(180) + 'Что решили по QVX?');
      expect(output.context).not.toContain('restricted-marker');
      expect(output.excludeLegacyMemory).toBe(true);
      expect(output.recallQuery).toBe('');
    }
  });

  it('keeps equal compound aliases ambiguous even when one card uses that alias as its formal title', async () => {
    storeCard('formal', oldFormat('Лесной пункт'));
    storeCard('other-formal', {
      ...oldFormat('Учебный кабинет'),
      aliases: ['Лесной пункт'],
    });
    const collision = await prompt('Лесной пункт');
    expect(collision.stats?.projectSelected).toBe(false);
    expect(collision.context).toContain('ambiguous_projects');
    expect(search('Лесной пункт').map((r) => r.kind)).toEqual([
      'project',
      'project',
    ]);
  });

  it('verifies the assignment and intervening direct turns by ingestion order at identical timestamps', async () => {
    const doc = oldFormat('Точный квартальный план');
    storeCard('quarter-plan', doc, 0, true, start, 'Подготовь ' + doc.title);
    const focusId = listMemoryState(db, scope).focusedSourceId!;
    db.exec(`CREATE TABLE messages(id TEXT,chat_jid TEXT,sender TEXT,content TEXT,timestamp TEXT,is_bot_message INTEGER);
      CREATE TABLE message_ingestion(id TEXT,chat_jid TEXT,sequence INTEGER);
      CREATE TABLE message_metadata(id TEXT,chat_jid TEXT,sender_identity_json TEXT);`);
    let sequence = 0;
    const turn = (id: string, text: string, origin = 'direct') => {
      db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,0)').run(
        id,
        scope.chatJid,
        input.senderId,
        text,
        start,
      );
      db.prepare('INSERT INTO message_ingestion VALUES (?,?,?)').run(
        id,
        scope.chatJid,
        ++sequence,
      );
      db.prepare('INSERT INTO message_metadata VALUES (?,?,?)').run(
        id,
        scope.chatJid,
        JSON.stringify({
          ...identity,
          channel: 'telegram',
          telegram_message_origin: origin,
        }),
      );
    };
    const follow = (id?: string) =>
      buildRecalledStructuredMemoryContext(
        db,
        { ...input, currentText: 'продолжай', currentMessageId: id },
        { now: () => start },
      );
    turn(focusId, 'Подготовь ' + doc.title);
    turn('check', 'статус');
    turn('forwarded', 'Другое задание', 'forwarded');
    turn('follow', 'продолжай');
    storeCard('different-card', oldFormat('Фоновый отчёт'), 0, false, start);
    expect((await follow('follow')).stats?.projectSelected).toBe(true);
    // Legacy host caller omitted the input ID but has a verified latest turn.
    expect((await follow()).stats?.projectSelected).toBe(true);
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(
      'Изменённый текст',
      focusId,
    );
    expect((await follow('follow')).stats?.projectSelected).toBe(false);
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(
      'Подготовь ' + doc.title,
      focusId,
    );
    turn('separate', 'Найди другой маршрут');
    turn('again', 'продолжай');
    expect((await follow('again')).stats?.projectSelected).toBe(false);
    expect((await follow('follow')).stats?.projectSelected).toBe(false);
    db.prepare('DELETE FROM messages WHERE id=?').run(focusId);
    expect((await follow('again')).stats?.projectSelected).toBe(false);
  });

  it('preserves read metadata on old-client updates and validates explicit links within the scope', async () => {
    const doc = oldFormat('Кабинет инспектора');
    storeCard('review', { ...doc, aliases: ['карточка наблюдателя'] });
    expect(
      storeCard('review', { ...doc, pending: ['Проверить'] }, 1, false).record,
    ).toMatchObject({
      revision: 2,
      card: { aliases: ['карточка наблюдателя'] },
    });
    const before = listMemoryState(db, scope);
    expect(() =>
      storeCard(
        'review',
        { ...doc, relatedProjectKeys: ['does-not-exist'] },
        2,
      ),
    ).toThrow('related_project_missing');
    expect(() =>
      storeCard('review', { ...doc, aliases: ['другие слова'] }, 2, false),
    ).toThrow('project_names_require_direct_source');
    expect(listMemoryState(db, scope)).toEqual(before);
  });
});
