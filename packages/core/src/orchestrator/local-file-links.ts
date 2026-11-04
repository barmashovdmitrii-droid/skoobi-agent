
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isSensitiveSendPath,
  noteChatFileSendFinished,
  noteChatFileSendStarted,
  queuedIpcFileSends,
  recentChatFileSend,
} from './chat-file-sends.js';
import { resolveGroupFolderPath } from './group-folder.js';
import type { RuntimePersistencePolicy } from './runtime-namespace.js';
import type { MessageRouter } from './types.js';

/** Telegram Bot API upload limit for documents. */
const MAX_ATTACH_BYTES = 50 * 1024 * 1024;
/** More links than this in one answer are not attached (name only). */
const MAX_ATTACHMENTS_PER_ANSWER = 5;
const MAX_CAPTION_CHARS = 1024;
const VIRTUAL_WORKSPACE_ROOT = '/workspace/group';

export interface LocalFileLinkMatch {
  /** Offsets of the whole link, `!` of an image link included. */
  start: number;
  end: number;
  label: string;
  target: string;
}

export type LocalFileLinkOutcome = 'sent' | 'already_sent' | 'text_only';

export interface LocalFileLinkResult {
  outcome: LocalFileLinkOutcome;
  /** Why the file was not attached (text_only) or how it went (already_sent). */
  reason?: string;
  basename: string;
}

export interface LocalFileLinkRewrite {
  text: string;
  links: LocalFileLinkResult[];
  /** Files the host attached, in the order they were sent. */
  sentFiles: string[];
}

const PROTECTED_RE =
  /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`|<internal>[\s\S]*?(?:<\/internal>|$)/g;
const MARKDOWN_LINK_RE =
  /(!?)\[([^[\]\n]{0,500})\]\(\s*(<[^<>\n]+>|[^\s<>()]+)\s*\)/g;

function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(PROTECTED_RE)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

/**
 * The local path a Markdown link target points at, or null for a web link
 * (or anything else that is not a path on this machine).
 */
export function localPathFromLinkTarget(
  rawTarget: string,
  context: { groupRoot?: string; homeDir?: string } = {},
): string | null {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }
  if (!target) return null;
  if (/^file:\/\//i.test(target)) {
    let rest = target.replace(/^file:\/\//i, '');
    if (/^localhost\//i.test(rest)) rest = rest.slice('localhost'.length);
    if (!rest.startsWith('/')) return null;
    try {
      rest = decodeURIComponent(rest);
    } catch {
      /* keep the raw spelling */
    }
    return rest;
  }
  if (target.startsWith('~/')) {
    return path.join(context.homeDir ?? os.homedir(), target.slice(2));
  }
  // An absolute path, never a protocol-relative «//host/…» web link.
  if (!/^\/[^/\s]/.test(target)) return null;
  if (
    context.groupRoot &&
    (target === VIRTUAL_WORKSPACE_ROOT ||
      target.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`))
  ) {
    return path.join(
      context.groupRoot,
      target.slice(VIRTUAL_WORKSPACE_ROOT.length),
    );
  }
  return target;
}

/** Markdown links to local files, outside code and <internal>. */
export function findLocalFileLinks(
  text: string,
  context: { groupRoot?: string; homeDir?: string } = {},
): LocalFileLinkMatch[] {
  if (!text.includes('](')) return [];
  const ranges = protectedRanges(text);
  const links: LocalFileLinkMatch[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // A link that starts inside code / <internal> is quoted, not given; a
    // A code span inside a link label remains part of that link.
    if (ranges.some(([from, to]) => start >= from && start < to)) continue;
    const target = match[3];
    if (localPathFromLinkTarget(target, context) === null) continue;
    links.push({ start, end, label: match[2], target });
  }
  return links;
}

function existingRealPath(candidate: string): string | null {
  const spellings = [candidate];
  if (/%[0-9A-Fa-f]{2}/.test(candidate)) {
    try {
      spellings.push(decodeURIComponent(candidate));
    } catch {
      /* not percent-encoded after all */
    }
  }
  const hash = candidate.indexOf('#');
  if (hash > 0) spellings.push(candidate.slice(0, hash));
  for (const spelling of spellings) {
    try {
      return fs.realpathSync(spelling);
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

/** A label that is itself a path says nothing the file name does not. */
function meaningfulLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '';
  if (localPathFromLinkTarget(trimmed) !== null) return '';
  if (trimmed.includes('/') && !/\s/.test(trimmed)) return '';
  return trimmed;
}

function sentReplacement(label: string, name: string, queued: boolean): string {
  const shown = label || `«${name}»`;
  return queued
    ? `${shown} (файл отдельным сообщением)`
    : `${shown} (файл выше)`;
}

function nameOnlyReplacement(
  label: string,
  name: string,
  offerToSend: boolean,
  fileExists = true,
): string {
  // A link to nothing keeps its words, and claims no file.
  if (!fileExists) return label || `«${name}»`;
  const offer = 'попросите, и я пришлю';
  if (!label) return offerToSend ? `«${name}» (${offer})` : `«${name}»`;
  if (label.includes(name)) return offerToSend ? `${label} (${offer})` : label;
  return offerToSend
    ? `${label} (файл «${name}» — ${offer})`
    : `${label} (файл «${name}»)`;
}

/**
 * Whether a chat turn may attach files from the chat's canonical folder: the
 * `isMain` of rewriteLocalFileLinks. A main registration alone is not enough.
 * A guest-tier turn in a multi-sender main chat (a member who is not the
 * owner) runs in the isolated untrusted-main workspace, and IPC refuses its
 * send_document for the canonical folder (guest_file_outside_workspace); the
 * host must not post the owner's CLAUDE.md or memory into that group for it
 * either. A DM keeps the canonical folder at any tier, as IPC does.
 */
export function chatTurnMayAttachLocalFiles(input: {
  groupIsMain: boolean;
  persistencePolicy: Pick<RuntimePersistencePolicy, 'untrustedMain'>;
}): boolean {
  return input.groupIsMain && !input.persistencePolicy.untrustedMain;
}

/**
 * Resolve every local-file link of a final answer and return the text to
 * deliver. Attachments go out BEFORE the text, so «файл выше» is true when
 * the text arrives. Never throws for a single link: an unreadable file or a
 * failed send leaves only that link as a name.
 */
export async function rewriteLocalFileLinks(input: {
  text: string;
  groupFolder: string;
  chatJid: string;
  router: Pick<MessageRouter, 'sendDocument'>;
  /**
   * Main (owner/admin) chats only: a guest chat never gets a host attachment.
   * Chat turns pass chatTurnMayAttachLocalFiles, scheduled tasks their owner
   * authorisation.
   */
  isMain: boolean;
  /** The chat's channel has sendDocument (WhatsApp does not). */
  canSendDocuments: boolean;
  nowMs?: number;
  /** Test seams. */
  groupRoot?: string;
  homeDir?: string;
  ipcMessagesDir?: string;
}): Promise<LocalFileLinkRewrite> {
  const groupRoot =
    input.groupRoot ?? resolveGroupFolderPath(input.groupFolder);
  const matches = findLocalFileLinks(input.text, {
    groupRoot,
    homeDir: input.homeDir,
  });
  if (matches.length === 0) {
    return { text: input.text, links: [], sentFiles: [] };
  }
  let groupRootReal: string | null = null;
  try {
    groupRootReal = fs.realpathSync(groupRoot);
  } catch {
    groupRootReal = null;
  }
  let queued: Set<string> | undefined;
  const handled = new Map<
    string,
    { result: LocalFileLinkResult; offerToSend: boolean; queued: boolean }
  >();
  const links: LocalFileLinkResult[] = [];
  const sentFiles: string[] = [];
  const replacements: string[] = [];

  for (const match of matches) {
    const label = meaningfulLabel(match.label);
    const candidate = localPathFromLinkTarget(match.target, {
      groupRoot,
      homeDir: input.homeDir,
    })!;
    const realPath = existingRealPath(candidate);
    const name = path.basename(realPath ?? candidate) || candidate;
    const textOnly = (reason: string, offerToSend = false): void => {
      const fileExists = reason !== 'missing' && reason !== 'not_a_file';
      links.push({ outcome: 'text_only', reason, basename: name });
      replacements.push(
        nameOnlyReplacement(label, name, offerToSend, fileExists),
      );
      if (realPath && fileExists) {
        handled.set(realPath, {
          result: { outcome: 'text_only', reason, basename: name },
          offerToSend,
          queued: false,
        });
      }
    };
    if (!realPath) {
      textOnly('missing');
      continue;
    }

    const earlier = handled.get(realPath);
    if (earlier) {
      // The same file twice in one answer: one attachment, one wording.
      if (earlier.result.outcome === 'text_only') {
        links.push({ ...earlier.result });
        replacements.push(
          nameOnlyReplacement(label, name, earlier.offerToSend),
        );
      } else {
        links.push({
          outcome: 'already_sent',
          reason: 'same_answer',
          basename: name,
        });
        replacements.push(sentReplacement(label, name, earlier.queued));
      }
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(realPath);
    } catch {
      textOnly('missing');
      continue;
    }
    if (!stat.isFile()) {
      textOnly('not_a_file');
      continue;
    }

    const previous = recentChatFileSend(
      input.groupFolder,
      realPath,
      input.nowMs,
    );
    queued ??= queuedIpcFileSends(input.groupFolder, input.ipcMessagesDir);
    if (previous || queued.has(realPath)) {
      const inFlight = previous !== 'sent';
      const result: LocalFileLinkResult = {
        outcome: 'already_sent',
        reason: inFlight ? 'queued' : 'sent',
        basename: name,
      };
      links.push(result);
      replacements.push(sentReplacement(label, name, inFlight));
      handled.set(realPath, { result, offerToSend: false, queued: inFlight });
      continue;
    }

    if (isSensitiveSendPath(realPath)) {
      textOnly('sensitive');
      continue;
    }
    if (!input.isMain) {
      textOnly('not_main_chat');
      continue;
    }
    // «попросите, и я пришлю» only where it is true: a main chat's own
    // send_document takes any readable non-secret file up to the upload limit.
    const sendable = stat.size <= MAX_ATTACH_BYTES && input.canSendDocuments;
    const insideWorkspace =
      groupRootReal !== null && isWithin(groupRootReal, realPath);
    if (!insideWorkspace) {
      textOnly('outside_workspace', sendable);
      continue;
    }
    if (stat.size > MAX_ATTACH_BYTES) {
      textOnly('too_large');
      continue;
    }
    if (!input.canSendDocuments) {
      textOnly('no_channel');
      continue;
    }
    if (sentFiles.length >= MAX_ATTACHMENTS_PER_ANSWER) {
      textOnly('limit', sendable);
      continue;
    }

    const caption =
      label && label !== name && label !== path.parse(name).name
        ? label.slice(0, MAX_CAPTION_CHARS)
        : undefined;
    noteChatFileSendStarted(input.groupFolder, realPath, input.nowMs);
    let delivered = false;
    try {
      delivered = await input.router.sendDocument(
        input.chatJid,
        realPath,
        caption,
        {
          // An attachment of the answer, not the answer: the text's own
          // delivery decides the chat cursor.
          suppressCursorAdvance: true,
          meta: { kind: 'local_file_document' },
        },
      );
    } catch {
      delivered = false;
    }
    noteChatFileSendFinished(
      input.groupFolder,
      realPath,
      delivered,
      input.nowMs,
    );
    if (!delivered) {
      textOnly('send_failed', sendable);
      continue;
    }
    sentFiles.push(realPath);
    const result: LocalFileLinkResult = { outcome: 'sent', basename: name };
    links.push(result);
    replacements.push(sentReplacement(label, name, false));
    handled.set(realPath, { result, offerToSend: false, queued: false });
  }

  let text = '';
  let cursor = 0;
  matches.forEach((match, index) => {
    text += input.text.slice(cursor, match.start) + replacements[index];
    cursor = match.end;
  });
  text += input.text.slice(cursor);
  return { text, links, sentFiles };
}

/** One local_file_link event per answer: counts and reasons, no paths. */
export function localFileLinkEventPayload(
  links: readonly LocalFileLinkResult[],
): Record<string, unknown> | null {
  if (links.length === 0) return null;
  const count = (outcome: LocalFileLinkOutcome) =>
    links.filter((link) => link.outcome === outcome).length;
  const reasons: Record<string, number> = {};
  for (const link of links) {
    if (link.outcome === 'sent' || !link.reason) continue;
    const key = `${link.outcome}:${link.reason}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return {
    found: links.length,
    sent: count('sent'),
    already_sent: count('already_sent'),
    text_only: count('text_only'),
    reasons,
  };
}
