import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
    return `<message sender="${escapeXml(senderName)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
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
