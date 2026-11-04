import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { isScheduledHistoryMessage } from './continuation-context.js';

import { escapeXml } from '@skoobi/shared';
export { escapeXml };

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  opts: { anonymizeSenderNames?: boolean } = {},
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const senderName = opts.anonymizeSenderNames
      ? m.is_from_me
        ? 'Assistant'
        : 'User'
      : m.sender_name;
    const origin = isScheduledHistoryMessage(m) ? ' origin="scheduled-task"' : '';
    // Source ids are supplied by the host, so memory can cite real messages
    // without inventing references or re-reading unrelated chat history.
    return `<message sender="${escapeXml(senderName)}" time="${escapeXml(displayTime)}" id="${escapeXml(m.id)}"${origin}>${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function prependRecentConversationContext(
  prompt: string,
  recentMessages: NewMessage[],
  timezone: string,
  opts: { anonymizeSenderNames?: boolean } = {},
): string {
  if (recentMessages.length === 0) return prompt;
  return [
    '<recent_conversation_context>',
    'Previous messages from this same chat only. Use for continuity; answer the new messages below.',
    formatMessages(recentMessages, timezone, opts),
    '</recent_conversation_context>',
    '',
    prompt,
  ].join('\n');
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
