import type { FileDeliveryReceipt } from './file-delivery.js';

const ACCEPTANCE_CODE_RE =
  /^(?:acceptance_|contract_|receipt_|checker_|requirements_|scenario_|environment_|isolation_|checks_)/;

/**
 * Plain words for why the host did not send a document (the router's or the
 * delivery store's code), or '' when the code says nothing a person can act
 * on. A missing archive checker once showed up only as «send_failed».
 */
export function documentBlockReasonText(code: string): string {
  switch (code) {
    case 'channel_unavailable':
      return 'нет связи с Telegram';
    case 'document_preflight_failed':
      return 'не получилось подготовить файл к отправке';
    case 'artifact_changed':
    case 'artifact_changed_during_check':
      return 'файл менялся во время отправки';
    case 'file_not_available':
      return 'файл недоступен из этого чата';
    default:
      return ACCEPTANCE_CODE_RE.test(code)
        ? 'не прошла обязательная проверка файла'
        : '';
  }
}

/** Host facts take precedence over a model's delivery claim. Only receipts
 * already selected by exact attempt and destination may be passed here. */
export function withFileDeliveryReconciliation(text: string, receipts: readonly FileDeliveryReceipt[]): string {
  const acknowledgedHashes = new Set(receipts.filter(r => r.state === 'delivered' && r.artifact.sha256).map(r=>r.artifact.sha256));
  const unresolved = receipts.filter(r => r.state !== 'delivered' &&
    !(r.state === 'blocked' && r.artifact.sha256 && acknowledgedHashes.has(r.artifact.sha256)));
  if (!unresolved.length) return text;
  const lines = unresolved.slice(0,10).map(r => {
    const name = r.artifact.name.replace(/[\r\n<>]/g,' ').slice(0,180);
    if (r.state === 'blocked') return `«${name}»: файл не отправлен — ${documentBlockReasonText(r.code) || 'обязательная проверка или подготовка не пройдена'}.`;
    if (r.state === 'checking' || r.state === 'sending') return `«${name}»: отправка ещё выполняется, подтверждения от канала пока нет.`;
    return `«${name}»: исход отправки неизвестен. Перед повторной отправкой нужно проверить квитанцию, чтобы не создать дубль.`;
  });
  if (unresolved.length > 10) lines.push(`Ещё файлов без подтверждения: ${unresolved.length - 10}.`);
  const notice = `Проверка доставки: результат по файлам ещё не завершён.\n${lines.join('\n')}`;
  return text.trim() ? `${notice}\n\n${text}` : notice;
}
