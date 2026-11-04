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
  chatTurnMayAttachLocalFiles,
  findLocalFileLinks,
  localFileLinkEventPayload,
  localPathFromLinkTarget,
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
    expect(recentChatFileSend(folder, research)).toBe('sent');
  });

  it('does not send a file the model already sent through send_document', async () => {

    const pdf = file('artifacts/fixture/Пример — список.pdf');
    noteChatFileSendStarted(folder, pdf);
    noteChatFileSendFinished(folder, pdf, true);
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
      'заметки (файл «notes.txt» — попросите, и я пришлю) и ссылка (файл «notes.txt» — попросите, и я пришлю)',
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
    expect(member.text).toBe('инструкции (файл «CLAUDE.md»)');
    expect(member.links[0].reason).toBe('not_main_chat');
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
    expect(result.text).toBe('Вот a.pdf (попросите, и я пришлю)');
    expect(result.links[0].reason).toBe('send_failed');
    expect(result.sentFiles).toEqual([]);
    expect(recentChatFileSend(folder, pdf)).toBeNull();
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

describe('chat file send registry', () => {
  beforeEach(() => _resetChatFileSendsForTests());

  it('remembers a confirmed send for 30 minutes and forgets a refused one', () => {
    const now = 1_792_000_000_000;
    noteChatFileSendStarted('chat_a', '/nonexistent/a.pdf', now);
    expect(recentChatFileSend('chat_a', '/nonexistent/a.pdf', now)).toBe(
      'sending',
    );
    noteChatFileSendFinished('chat_a', '/nonexistent/a.pdf', true, now);
    expect(recentChatFileSend('chat_a', '/nonexistent/a.pdf', now)).toBe(
      'sent',
    );
    expect(recentChatFileSend('chat_b', '/nonexistent/a.pdf', now)).toBeNull();
    expect(
      recentChatFileSend(
        'chat_a',
        '/nonexistent/a.pdf',
        now + RECENT_CHAT_FILE_SEND_MS + 1,
      ),
    ).toBeNull();

    noteChatFileSendStarted('chat_a', '/nonexistent/b.pdf', now);
    noteChatFileSendFinished('chat_a', '/nonexistent/b.pdf', false, now);
    expect(recentChatFileSend('chat_a', '/nonexistent/b.pdf', now)).toBeNull();
  });

  it('reads only photo/document envelopes from the queue and skips junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-ipc-queue-'));
    try {
      fs.writeFileSync(
        path.join(dir, '1.json'),
        JSON.stringify({ type: 'photo', filePath: '/nonexistent/p.png' }),
      );
      fs.writeFileSync(
        path.join(dir, '2.json'),
        JSON.stringify({ type: 'message', text: 'hi' }),
      );
      fs.writeFileSync(path.join(dir, '3.json'), '{not json');
      fs.writeFileSync(path.join(dir, '4.tmp'), '{}');
      expect([...queuedIpcFileSends('chat_a', dir)]).toEqual([
        '/nonexistent/p.png',
      ]);
      expect(queuedIpcFileSends('chat_a', path.join(dir, 'missing')).size).toBe(
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
