import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetChatFileSendsForTests,
  isSensitiveSendPath,
  noteChatFileSendFinished,
  noteChatFileSendStarted,
  queuedIpcFileSends,
  recentChatFileSend,
  RECENT_CHAT_FILE_SEND_MS,
} from './chat-file-sends.js';
import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
} from './instance-profile.js';
import {
  chatMayAttachOwnerWorkFiles,
  chatTurnMayAttachLocalFiles,
  findLocalFileLinks,
  isInternalInstructionPath,
  localFileLinkEventPayload,
  localPathFromLinkTarget,
  ownerWorkFileRoots,
  rewriteLocalFileLinks,
} from './local-file-links.js';
import { runtimePersistencePolicy } from './runtime-namespace.js';

interface SentDocument {
  chatJid: string;
  filePath: string;
  caption?: string;
  options?: { suppressCursorAdvance?: boolean; meta?: Record<string, unknown> };
}

function documentRouter(sent: SentDocument[], ok = true) {
  return {
    sendDocument: async (
      chatJid: string,
      filePath: string,
      caption?: string,
      options?: SentDocument['options'],
    ) => {
      sent.push({ chatJid, filePath, caption, options });
      return ok;
    },
  };
}

describe('finding links to local files', () => {
  it('finds angle-bracket, plain and file:// links, not web links', () => {
    const text = [
      'PDF: [Пример — список файлов.pdf](</Users/example/chat/список покупок.pdf>)',
      'Разбор: [research.md](/Users/example/chat/research.md)',
      'Ещё: [заметка](file:///Users/example/chat/My%20note.txt)',
      'Сайт: [пример](https://example.com/a) и [тег](tg://resolve?domain=x)',
      'Хост: [зеркало](//cdn.example.com/x.js)',
    ].join('\n');
    const links = findLocalFileLinks(text);
    expect(links.map((link) => link.label)).toEqual([
      'Пример — список файлов.pdf',
      'research.md',
      'заметка',
    ]);
  });

  it('leaves links inside code and <internal> alone, but not code inside a label', () => {
    const text = [
      '```',
      '[лог](/Users/example/chat/log.txt)',
      '```',
      'Путь: `[адрес](/Users/example/chat/a.txt)`',
      '<internal>[x](/Users/example/chat/x.txt)</internal>',
      '[`report.md`](/Users/example/chat/report.md)',
    ].join('\n');
    const links = findLocalFileLinks(text);
    expect(links.map((link) => link.label)).toEqual(['`report.md`']);
  });

  it('maps file://, ~/ and the virtual workspace path to real paths', () => {
    expect(
      localPathFromLinkTarget('<file:///Users/example/My%20File.pdf>'),
    ).toBe('/Users/example/My File.pdf');
    expect(localPathFromLinkTarget('file://localhost/tmp/a.txt')).toBe(
      '/tmp/a.txt',
    );
    expect(localPathFromLinkTarget('~/x.txt', { homeDir: '/home/example/' })).toBe(
      '/home/example/x.txt',
    );
    expect(
      localPathFromLinkTarget('/workspace/group/out/a.pdf', {
        groupRoot: '/srv/groups/chat_one',
      }),
    ).toBe('/srv/groups/chat_one/out/a.pdf');
    expect(localPathFromLinkTarget('https://example.com/a.pdf')).toBeNull();
    expect(localPathFromLinkTarget('relative/a.pdf')).toBeNull();
  });
});

describe('rewriting local file links in a final answer (C38)', () => {
  let root: string;
  let groupRoot: string;
  let ipcMessagesDir: string;
  const folder = 'telegram_linktest';

  beforeEach(() => {
    _resetChatFileSendsForTests();
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-local-links-')),
    );
    groupRoot = path.join(root, 'groups', folder);
    ipcMessagesDir = path.join(root, 'ipc', folder, 'messages');
    fs.mkdirSync(path.join(groupRoot, 'artifacts'), { recursive: true });
    fs.mkdirSync(ipcMessagesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    _resetChatFileSendsForTests();
  });

  function file(relative: string, body = 'content'): string {
    const filePath = path.join(groupRoot, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body);
    return filePath;
  }

  function rewrite(
    text: string,
    sent: SentDocument[],
    over: Partial<Parameters<typeof rewriteLocalFileLinks>[0]> = {},
  ) {
    return rewriteLocalFileLinks({
      text,
      groupFolder: folder,
      chatJid: 'tg:100',
      router: documentRouter(sent),
      isMain: true,
      canSendDocuments: true,
      groupRoot,
      ipcMessagesDir,
      ...over,
    });
  }

  it('attaches a workspace file before the text and drops the path', async () => {
    // research.md was once linked by path and never sent.
    const research = file('artifacts/research.md');
    const sent: SentDocument[] = [];
    const result = await rewrite(
      `Разбор готов. Подробно: [research.md](${research})`,
      sent,
    );
    expect(result.text).toBe('Разбор готов. Подробно: research.md (файл выше)');
    expect(sent).toEqual([
      {
        chatJid: 'tg:100',
        filePath: research,
        caption: undefined,
        options: {
          suppressCursorAdvance: true,
          meta: { kind: 'local_file_document' },
        },
      },
    ]);
    expect(result.sentFiles).toEqual([research]);
    expect(result.links).toEqual([
      { outcome: 'sent', basename: 'research.md' },
    ]);
    // The next answer linking the same file does not send it again.
    expect(recentChatFileSend(folder, 'tg:100', research)).toBe('sent');
  });

  it('does not send a file the model already sent through send_document', async () => {
    // The PDF went out 18 s before the answer that linked it.
    const pdf = file('artifacts/fixture/Пример — список.pdf');
    noteChatFileSendStarted(folder, 'tg:100', pdf);
    noteChatFileSendFinished(folder, 'tg:100', pdf, true);
    const sent: SentDocument[] = [];
    const result = await rewrite(
      `Список: [Пример — список.pdf](<${pdf}>)`,
      sent,
    );
    expect(sent).toEqual([]);
    expect(result.text).toBe('Список: Пример — список.pdf (файл выше)');
    expect(result.links[0]).toMatchObject({
      outcome: 'already_sent',
      reason: 'sent',
    });
  });

  it('does not send a file whose send_document envelope still waits in the IPC queue', async () => {
    const pdf = file('artifacts/plan.pdf');
    fs.writeFileSync(
      path.join(ipcMessagesDir, '1792000000000-abc.json'),
      JSON.stringify({ type: 'document', chatJid: 'tg:100', filePath: pdf }),
    );
    const sent: SentDocument[] = [];
    const result = await rewrite(`План: [план](${pdf})`, sent);
    expect(sent).toEqual([]);
    expect(result.text).toBe('План: план (файл отдельным сообщением)');
    expect(result.links[0]).toMatchObject({
      outcome: 'already_sent',
      reason: 'queued',
    });
  });

  it('sends a file linked twice in one answer only once', async () => {
    const report = file('report.pdf');
    const sent: SentDocument[] = [];
    const result = await rewrite(
      `[Отчёт](${report}) … ещё раз: [отчёт](file://${report})`,
      sent,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].caption).toBe('Отчёт');
    expect(result.text).toBe('Отчёт (файл выше) … ещё раз: отчёт (файл выше)');
    expect(result.links.map((link) => link.outcome)).toEqual([
      'sent',
      'already_sent',
    ]);
  });

  it('never attaches a file outside the chat workspace, but offers it in a main chat', async () => {
    const outsideDir = path.join(root, 'elsewhere');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, 'notes.txt');
    fs.writeFileSync(outside, 'x');
    // A symlink inside the workspace that points out of it is outside too.
    fs.symlinkSync(outside, path.join(groupRoot, 'link.txt'));
    const sent: SentDocument[] = [];
    const result = await rewrite(
      `[заметки](${outside}) и [ссылка](${path.join(groupRoot, 'link.txt')})`,
      sent,
    );
    expect(sent).toEqual([]);
    expect(result.text).toBe(
      'заметки (файл «notes.txt», скажи — пришлю) и ссылка (файл «notes.txt», скажи — пришлю)',
    );
    expect(result.links[0]).toMatchObject({
      outcome: 'text_only',
      reason: 'outside_workspace',
    });
  });

  it('never attaches a secret-bearing file and promises nothing about it', async () => {
    const secret = file('.env', 'TOKEN=x');
    const sent: SentDocument[] = [];
    const result = await rewrite(`[настройки](${secret})`, sent);
    expect(sent).toEqual([]);
    expect(result.text).toBe('настройки (файл «.env»)');
    expect(result.links[0].reason).toBe('sensitive');
  });

  it('attaches nothing in a guest chat or without a document-capable channel', async () => {
    const pdf = file('a.pdf');
    const sent: SentDocument[] = [];
    const guest = await rewrite(`[a.pdf](${pdf})`, sent, { isMain: false });
    expect(guest.text).toBe('a.pdf');
    expect(guest.links[0].reason).toBe('not_main_chat');

    const whatsapp = await rewrite(`[a.pdf](${pdf})`, sent, {
      canSendDocuments: false,
    });
    expect(whatsapp.text).toBe('a.pdf');
    expect(whatsapp.links[0].reason).toBe('no_channel');
    expect(sent).toEqual([]);
  });

  it('follows the run trust, not the registration, in a multi-sender main chat', async () => {
    // A member who is not the owner in a group registered as main runs as a
    // guest in the isolated workspace; IPC refuses him the canonical folder,
    // so a link to the owner's CLAUDE.md must not attach it for him.
    const instructions = file('CLAUDE.md', '# owner instructions');
    const groupJid = 'tg:-100123';
    const mayAttach = (
      chatJid: string,
      credentialProxyTier: 'owner' | 'guest',
      groupIsMain = true,
    ) =>
      chatTurnMayAttachLocalFiles({
        groupIsMain,
        persistencePolicy: runtimePersistencePolicy({
          groupIsMain,
          credentialProxyTier,
          chatJid,
        }),
      });

    expect(mayAttach(groupJid, 'guest')).toBe(false);
    expect(mayAttach('1111111@g.us', 'guest')).toBe(false);
    // The owner in that group, and any turn in a main DM, keep attachments
    // (a DM's IPC send_document takes the canonical folder at any tier).
    expect(mayAttach(groupJid, 'owner')).toBe(true);
    expect(mayAttach('tg:9000000001', 'guest')).toBe(true);
    expect(mayAttach('tg:9000000001', 'owner', false)).toBe(false);

    const sent: SentDocument[] = [];
    const member = await rewrite(`[инструкции](${instructions})`, sent, {
      chatJid: groupJid,
      isMain: mayAttach(groupJid, 'guest'),
    });
    expect(sent).toEqual([]);
    // The bot's own rules are never offered, not even by name (W08).
    expect(member.text).toBe('инструкции');
    expect(member.links[0].reason).toBe('internal');
  });

  it('keeps only the words of a link to a missing file', async () => {
    const sent: SentDocument[] = [];
    const result = await rewrite(
      `[черновик](${path.join(groupRoot, 'gone.md')}) и [${path.join(groupRoot, 'gone2.md')}](${path.join(groupRoot, 'gone2.md')})`,
      sent,
    );
    expect(result.text).toBe('черновик и «gone2.md»');
    expect(result.links.map((link) => link.reason)).toEqual([
      'missing',
      'missing',
    ]);
  });

  it('falls back to the name when the channel refuses the file', async () => {
    const pdf = file('a.pdf');
    const sent: SentDocument[] = [];
    const result = await rewriteLocalFileLinks({
      text: `Вот [a.pdf](${pdf})`,
      groupFolder: folder,
      chatJid: 'tg:100',
      router: documentRouter(sent, false),
      isMain: true,
      canSendDocuments: true,
      groupRoot,
      ipcMessagesDir,
    });
    // W08: no «скажи — пришлю» right after the same send failed.
    expect(result.text).toBe(
      `Вот a.pdf (⚠️ файл «a.pdf» не дошёл. Он лежит тут: \`${pdf}\`)`,
    );
    expect(result.links[0].reason).toBe('send_failed:channel_refused');
    expect(result.sentFiles).toEqual([]);
    expect(recentChatFileSend(folder, 'tg:100', pdf)).toBeNull();
  });

  it('attaches at most five files of one answer', async () => {
    const paths = [1, 2, 3, 4, 5, 6].map((n) => file(`f${n}.txt`));
    const sent: SentDocument[] = [];
    const result = await rewrite(
      paths.map((p, i) => `[f${i + 1}.txt](${p})`).join(' '),
      sent,
    );
    expect(sent).toHaveLength(5);
    expect(result.links.at(-1)).toMatchObject({
      outcome: 'text_only',
      reason: 'limit',
    });
  });

  it('returns the text untouched when it has no local links', async () => {
    const sent: SentDocument[] = [];
    const text =
      'Без ссылок, только [сайт](https://example.com) и `/Users/example/b`';
    const result = await rewrite(text, sent);
    expect(result).toEqual({ text, links: [], sentFiles: [] });
  });

  it('summarises an answer in one event payload without paths', () => {
    expect(localFileLinkEventPayload([])).toBeNull();
    expect(
      localFileLinkEventPayload([
        { outcome: 'sent', basename: 'a.pdf' },
        { outcome: 'already_sent', reason: 'sent', basename: 'b.pdf' },
        { outcome: 'text_only', reason: 'missing', basename: 'c.pdf' },
        { outcome: 'text_only', reason: 'missing', basename: 'd.pdf' },
      ]),
    ).toEqual({
      found: 4,
      sent: 1,
      already_sent: 1,
      text_only: 2,
      reasons: { 'already_sent:sent': 1, 'text_only:missing': 2 },
    });
  });
});

describe('W08: owner work folders, internal files and honest send failures', () => {
  let root: string;
  let home: string;
  let groupsDir: string;
  let dataDir: string;
  let ownerRoot: string;
  let ownerChat: string;
  const ownerFolder = 'telegram_main';

  beforeEach(() => {
    _resetChatFileSendsForTests();
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-w08-links-')),
    );
    home = path.join(root, 'home');
    groupsDir = path.join(root, 'groups');
    dataDir = path.join(root, 'data');
    ownerRoot = path.join(home, 'Desktop', 'ПРОЕКТЫ');
    ownerChat = path.join(groupsDir, ownerFolder);
    for (const dir of [ownerRoot, ownerChat, dataDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    resetInstanceProfileForTests();
    fs.rmSync(root, { recursive: true, force: true });
    _resetChatFileSendsForTests();
  });

  function put(filePath: string, body = 'content'): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body);
    return filePath;
  }

  function rewriteAs(
    text: string,
    router: Parameters<typeof rewriteLocalFileLinks>[0]['router'],
    over: Partial<Parameters<typeof rewriteLocalFileLinks>[0]> = {},
  ) {
    return rewriteLocalFileLinks({
      text,
      groupFolder: ownerFolder,
      chatJid: 'tg:100',
      router,
      isMain: true,
      canSendDocuments: true,
      ownerWorkFolders: true,
      groupRoot: ownerChat,
      homeDir: home,
      groupsDir,
      dataDir,
      codeRoot: path.join(root, 'code'),
      ownerWorkRoots: [ownerRoot],
      ipcMessagesDir: path.join(root, 'ipc', 'messages'),
      retryDelayMs: 0,
      ...over,
    });
  }

  it('attaches a Cyrillic-named archive from the owner work folder in the owner chat only', async () => {
    // A delivery archive in the owner's work folder
    // (…/delivery/…zip) was offered instead of sent.
    const archive = put(
      path.join(
        ownerRoot,
        'gf-10001',
        'delivery',
        'Игра_0.8.0 полный выпуск.zip',
      ),
    );
    const sent: SentDocument[] = [];
    const owner = await rewriteAs(
      `Готово: [Игра_0.8.0 полный выпуск.zip](<${archive}>)`,
      documentRouter(sent),
    );
    expect(owner.text).toBe('Готово: Игра_0.8.0 полный выпуск.zip (файл выше)');
    expect(sent.map((item) => item.filePath)).toEqual([archive]);
    expect(owner.links).toEqual([
      { outcome: 'sent', basename: 'Игра_0.8.0 полный выпуск.zip' },
    ]);

    // A second admin's chat (no owner work folders) only gets the offer.
    _resetChatFileSendsForTests();
    const secondarySent: SentDocument[] = [];
    const secondary = await rewriteAs(
      `Готово: [архив](<${archive}>)`,
      documentRouter(secondarySent),
      { ownerWorkFolders: false, groupFolder: 'telegram_fixture_secondary' },
    );
    expect(secondarySent).toEqual([]);
    expect(secondary.links[0].reason).toBe('outside_workspace');
    expect(secondary.text).toBe(
      'Готово: архив (файл «Игра_0.8.0 полный выпуск.zip», скажи — пришлю)',
    );
  });

  it('attaches a percent-encoded file:// link to a Cyrillic archive inside the chat folder', async () => {
    const archive = put(
      path.join(
        ownerChat,
        'output',
        'game-campaign-20260101',
        'Игра_0.8.0.zip',
      ),
    );
    const sent: SentDocument[] = [];
    const result = await rewriteAs(
      `[Архив](file://${encodeURI(archive)})`,
      documentRouter(sent),
      { ownerWorkFolders: false },
    );
    expect(sent.map((item) => item.filePath)).toEqual([archive]);
    expect(sent[0].caption).toBe('Архив');
    expect(result.text).toBe('Архив (файл выше)');
  });

  it("attaches another chat's output/ folder for the owner, never its other files", async () => {
    const report = put(
      path.join(groupsDir, 'telegram_fixture_secondary', 'output', 'smeta.pdf'),
    );
    const notes = put(
      path.join(groupsDir, 'telegram_fixture_secondary', 'notes', 'n.txt'),
    );
    const sent: SentDocument[] = [];
    const result = await rewriteAs(
      `[смета](${report}) и [заметки](${notes})`,
      documentRouter(sent),
    );
    expect(sent.map((item) => item.filePath)).toEqual([report]);
    expect(result.links.map((link) => link.reason ?? link.outcome)).toEqual([
      'sent',
      'outside_workspace',
    ]);
  });

  it('keeps a secret refused even inside an owner work folder', async () => {
    const secret = put(path.join(ownerRoot, 'side-project', '.env'), 'X=1');
    const sent: SentDocument[] = [];
    const result = await rewriteAs(
      `[настройки](${secret})`,
      documentRouter(sent),
    );
    expect(sent).toEqual([]);
    expect(result.links[0].reason).toBe('sensitive');
  });

  it('never offers the bot’s own skills, rules or memory', async () => {
    // «SKILL.md — попросите, и я пришлю» four times in a week.
    const skill = put(path.join(dataDir, 'skills', 'game-factory', 'SKILL.md'));
    const reference = put(
      path.join(
        dataDir,
        'codex-homes',
        ownerFolder,
        'skills',
        'store-submit',
        'notes.md',
      ),
    );
    const rules = put(path.join(ownerChat, 'CLAUDE.md'));
    const memory = put(path.join(ownerChat, 'memory', 'people.md'));
    const codexHome = put(path.join(home, '.codex', 'config.toml'));
    const sent: SentDocument[] = [];
    const result = await rewriteAs(
      [
        `[SKILL.md](${skill})`,
        `[справка навыка](${reference})`,
        `[${rules}](${rules})`,
        `[память](${memory})`,
        `[настройки](${codexHome})`,
      ].join(' | '),
      documentRouter(sent),
    );
    expect(sent).toEqual([]);
    expect(result.text).toBe(
      'SKILL.md | справка навыка | внутренняя инструкция | память | настройки',
    );
    expect(result.text).not.toContain('пришлю');
    expect(result.links.every((link) => link.reason === 'internal')).toBe(true);
    expect(localFileLinkEventPayload(result.links)?.reasons).toEqual({
      'text_only:internal': 5,
    });
  });

  it('offers a picture the bot drew (codex-homes/*/generated_images), but keeps the rest of a Codex home internal', async () => {
    // image-pipeline keeps drawings there for «пришли картинку»; the review
    // of W08 found the whole codex-homes treated as instructions.
    const picture = put(
      path.join(dataDir, 'codex-homes', ownerFolder, 'generated_images', 'ig_1', 'кот.png'),
    );
    const config = put(path.join(dataDir, 'codex-homes', ownerFolder, 'config.toml'));
    const transcript = put(
      path.join(dataDir, 'codex-homes', ownerFolder, 'sessions', '2026', '11', '08', 'rollout.jsonl'),
    );
    const roots = { homeDir: home, dataDir, groupsDir, codeRoot: path.join(root, 'code') };
    expect(isInternalInstructionPath(picture, roots)).toBe(false);
    expect(isInternalInstructionPath(config, roots)).toBe(true);
    expect(isInternalInstructionPath(transcript, roots)).toBe(true);
    // Not «generated_images» one level too high or too deep.
    expect(
      isInternalInstructionPath(path.join(dataDir, 'codex-homes', 'generated_images'), roots),
    ).toBe(true);

    const sent: SentDocument[] = [];
    const result = await rewriteAs(
      `[картинка](${picture}) и [настройки](${config})`,
      documentRouter(sent),
    );
    expect(sent).toEqual([]);
    expect(result.links.map((link) => link.reason)).toEqual(['outside_workspace', 'internal']);
    expect(result.text).toBe('картинка (файл «кот.png», скажи — пришлю) и настройки');
  });

  it('names and offers the owner\'s private working files instead of attaching them', async () => {
    // The owner's work folder also holds audits and scans next to deliveries.
    const scan = put(path.join(ownerRoot, 'skoobi-fixture-update', 'secret-scan.private.log'));
    const fingerprints = put(
      path.join(ownerRoot, 'release-audit', 'public-history-private-fingerprints.json'),
    );
    const hidden = put(path.join(ownerRoot, '.skoobi-review-3d', 'day3-findings.txt'));
    const privateOutput = put(
      path.join(groupsDir, 'telegram_fixture_secondary', 'output', 'notes.private.md'),
    );
    const delivery = put(path.join(ownerRoot, 'gf-10001', 'delivery', 'privacy-policy.html'));
    const sent: SentDocument[] = [];
    const result = await rewriteAs(
      [
        `[скан](${scan})`,
        `[отпечатки](${fingerprints})`,
        `[разбор](${hidden})`,
        `[заметки](${privateOutput})`,
        `[политика](${delivery})`,
      ].join(' | '),
      documentRouter(sent),
    );
    // A word that only contains «private» is not a private file.
    expect(sent.map((item) => item.filePath)).toEqual([delivery]);
    expect(result.links.map((link) => link.reason ?? link.outcome)).toEqual([
      'outside_workspace',
      'outside_workspace',
      'outside_workspace',
      'outside_workspace',
      'sent',
    ]);
    expect(result.text).toContain('скан (файл «secret-scan.private.log», скажи — пришлю)');
    expect(result.text).toContain('политика (файл выше)');
  });

  it('keeps the owner work folders to his own chat and his own turn', () => {
    expect(chatMayAttachOwnerWorkFiles({ mayAttach: true, groupFolder: 'telegram_main' })).toBe(true);
    // A second admin's chat: full access to his own folder, never the owner's.
    expect(chatMayAttachOwnerWorkFiles({ mayAttach: true, groupFolder: 'telegram_fixture_secondary' })).toBe(false);
    // A guest-tier turn in the owner's chat.
    expect(chatMayAttachOwnerWorkFiles({ mayAttach: false, groupFolder: 'telegram_main' })).toBe(false);
  });

  it('takes the owner work folders from the instance profile, none by default', () => {
    expect(ownerWorkFileRoots('/Users/example/fixture-home')).toEqual([]);

    // The Desktop project folder (with the game factory's gf-*/delivery) only.
    setInstanceProfileForTests({ owner: { workFolders: ['Desktop/ПРОЕКТЫ'] } });
    expect(ownerWorkFileRoots('/Users/example/fixture-home')).toEqual([
      path.join('/Users/example/fixture-home', 'Desktop', 'ПРОЕКТЫ'),
    ]);

    setInstanceProfileForTests({
      owner: { workFolders: ['Desktop/ПРОЕКТЫ', 'Documents/fixture-work'] },
    });
    expect(ownerWorkFileRoots('/Users/example/fixture-home')).toEqual([
      '/Users/example/fixture-home/Desktop/ПРОЕКТЫ',
      '/Users/example/fixture-home/Documents/fixture-work',
    ]);
  });

  it('attaches from the profile work folder when no roots are passed, and nothing without the profile', async () => {
    const archive = put(
      path.join(ownerRoot, 'gf-10001', 'delivery', 'build.zip'),
    );
    const text = `Готово: [архив](<${archive}>)`;

    // No work folder is configured: the file is outside the chat workspace.
    const neutralSent: SentDocument[] = [];
    const neutral = await rewriteAs(text, documentRouter(neutralSent), {
      ownerWorkRoots: undefined,
    });
    expect(neutralSent).toEqual([]);
    expect(neutral.links[0].reason).toBe('outside_workspace');

    _resetChatFileSendsForTests();
    setInstanceProfileForTests({ owner: { workFolders: ['Desktop/ПРОЕКТЫ'] } });
    const sent: SentDocument[] = [];
    const configured = await rewriteAs(text, documentRouter(sent), {
      ownerWorkRoots: undefined,
    });
    expect(sent.map((item) => item.filePath)).toEqual([archive]);
    expect(configured.text).toBe('Готово: архив (файл выше)');
  });

  it('says honestly that a blocked file did not arrive, with the real code in the event', async () => {
    // The archive checker was missing, the send was blocked in
    // 5 ms, and the answer still said «попросите, и я пришлю».
    const archive = put(
      path.join(ownerRoot, 'game-campaign', 'Игра_0.8.0.zip'),
    );
    const calls: string[] = [];
    const router = {
      sendDocument: async () => {
        throw new Error('legacy path must not be used');
      },
      sendDocumentResult: async (_jid: string, filePath: string) => {
        calls.push(filePath);
        return { state: 'blocked' as const, code: 'acceptance_unavailable' };
      },
    };
    const result = await rewriteAs(`Держи [Игра](${archive})`, router);
    expect(calls).toEqual([archive]); // a failed check is not retried
    expect(result.text).toBe(
      'Держи Игра (⚠️ файл «Игра_0.8.0.zip» не дошёл: не прошла обязательная проверка файла. Он лежит тут: `~/Desktop/ПРОЕКТЫ/game-campaign/Игра_0.8.0.zip`)',
    );
    expect(result.text).not.toMatch(/пришлю|отправил|файл выше/);
    expect(result.sentFiles).toEqual([]);
    expect(localFileLinkEventPayload(result.links)?.reasons).toEqual({
      'text_only:send_failed:acceptance_unavailable': 1,
    });
    expect(recentChatFileSend(ownerFolder, 'tg:100', archive)).toBeNull();
  });

  it('retries once a send refused before Telegram, and never an unknown outcome', async () => {
    const pdf = put(path.join(ownerChat, 'output', 'plan.pdf'));
    const outcomes = [
      { state: 'blocked' as const, code: 'channel_unavailable' },
      { state: 'delivered' as const, code: 'api_acknowledged' },
    ];
    let calls = 0;
    const flaky = {
      sendDocument: async () => false,
      sendDocumentResult: async () => outcomes[calls++],
    };
    const retried = await rewriteAs(`[план](${pdf})`, flaky);
    expect(calls).toBe(2);
    expect(retried.text).toBe('план (файл выше)');

    _resetChatFileSendsForTests();
    let unknownCalls = 0;
    const lost = {
      sendDocument: async () => false,
      sendDocumentResult: async () => {
        unknownCalls++;
        return { state: 'unknown' as const, code: 'channel_outcome_unknown' };
      },
    };
    const unknown = await rewriteAs(
      `[план](${pdf}) и снова [план](${pdf})`,
      lost,
    );
    expect(unknownCalls).toBe(1);
    expect(unknown.text).toBe(
      `план (⚠️ не уверен, что файл «plan.pdf» дошёл — проверь чат выше; он лежит тут: \`${pdf}\`) и снова план (файл «plan.pdf»)`,
    );
    expect(unknown.links.map((link) => link.reason)).toEqual([
      'send_failed:channel_outcome_unknown',
      'send_failed:channel_outcome_unknown',
    ]);
  });

  it('gives up after one retry and names the reason', async () => {
    const pdf = put(path.join(ownerChat, 'output', 'plan.pdf'));
    let calls = 0;
    const offline = {
      sendDocument: async () => false,
      sendDocumentResult: async () => {
        calls++;
        return { state: 'blocked' as const, code: 'channel_unavailable' };
      },
    };
    const result = await rewriteAs(`[план](${pdf})`, offline);
    expect(calls).toBe(2);
    expect(result.text).toContain('не дошёл: нет связи с Telegram');
    expect(result.links[0].reason).toBe('send_failed:channel_unavailable');

    // One retry per answer: three refused links cost one pause, not three.
    _resetChatFileSendsForTests();
    calls = 0;
    const more = [1, 2, 3].map((n) =>
      put(path.join(ownerChat, 'output', `p${n}.pdf`)),
    );
    await rewriteAs(more.map((p, i) => `[p${i + 1}](${p})`).join(' '), offline);
    expect(calls).toBe(4);
  });
});

describe('chat file send registry', () => {
  beforeEach(() => _resetChatFileSendsForTests());

  it('remembers a confirmed send for 30 minutes and forgets a refused one', () => {
    const now = 1_792_000_000_000;
    noteChatFileSendStarted('chat_a', 'tg:100', '/nonexistent/a.pdf', now);
    expect(recentChatFileSend('chat_a', 'tg:100', '/nonexistent/a.pdf', now)).toBe(
      'sending',
    );
    noteChatFileSendFinished('chat_a', 'tg:100', '/nonexistent/a.pdf', true, now);
    expect(recentChatFileSend('chat_a', 'tg:100', '/nonexistent/a.pdf', now)).toBe(
      'sent',
    );
    expect(recentChatFileSend('chat_a', 'tg:other', '/nonexistent/a.pdf', now)).toBeNull();
    expect(recentChatFileSend('chat_b', 'tg:100', '/nonexistent/a.pdf', now)).toBeNull();
    expect(
      recentChatFileSend(
        'chat_a', 'tg:100',
        '/nonexistent/a.pdf',
        now + RECENT_CHAT_FILE_SEND_MS + 1,
      ),
    ).toBeNull();

    noteChatFileSendStarted('chat_a', 'tg:100', '/nonexistent/b.pdf', now);
    noteChatFileSendFinished('chat_a', 'tg:100', '/nonexistent/b.pdf', false, now);
    expect(recentChatFileSend('chat_a', 'tg:100', '/nonexistent/b.pdf', now)).toBeNull();
  });

  it('reads only photo/document envelopes from the queue and skips junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-ipc-queue-'));
    try {
      fs.writeFileSync(
        path.join(dir, '1.json'),
        JSON.stringify({ type: 'photo', chatJid: 'tg:100', filePath: '/nonexistent/p.png' }),
      );
      fs.writeFileSync(
        path.join(dir, '2.json'),
        JSON.stringify({ type: 'message', text: 'hi' }),
      );
      fs.writeFileSync(path.join(dir, '3.json'), '{not json');
      fs.writeFileSync(path.join(dir, '4.tmp'), '{}');
      expect([...queuedIpcFileSends('chat_a', 'tg:100', dir)]).toEqual([
        '/nonexistent/p.png',
      ]);
      expect(queuedIpcFileSends('chat_a', 'tg:other', dir).size).toBe(0);
      expect(queuedIpcFileSends('chat_a', 'tg:100', path.join(dir, 'missing')).size).toBe(
        0,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats credentials, keys and databases as secret', () => {
    expect(isSensitiveSendPath('/srv/groups/chat/.env.local')).toBe(true);
    expect(isSensitiveSendPath('/srv/groups/chat/store/messages.db')).toBe(
      true,
    );
    expect(isSensitiveSendPath('/srv/groups/chat/key.pem')).toBe(true);
    expect(isSensitiveSendPath('/srv/groups/chat/report.pdf')).toBe(false);
  });
});
