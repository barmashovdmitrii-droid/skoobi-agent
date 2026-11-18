import type { SandboxPolicyLimitReason } from '../runtimes/sandbox-policy-budget.js';

export const sandboxPolicyNotices: Record<SandboxPolicyLimitReason, string> = {
  list_entries:
    'Песочница остановила запуск. В одном списке разрешений слишком много записей.',
  total_entries:
    'Песочница остановила запуск. Общее число записей во всех списках разрешений превышает лимит.',
  entry_bytes:
    'Песочница остановила запуск. Один путь или домен в настройках разрешений слишком длинный.',
  policy_bytes:
    'Песочница остановила запуск. Общий размер настроек разрешений превышает лимит.',
};

/** Local host state. Store the cause and the input boundary, never the policy itself. */
export interface SandboxPolicyNotice {
  reason: SandboxPolicyLimitReason;
  cursor: string;
  replyJid: string;
  replyFolder: string;
  checkpoints: string[];
  attempted?: boolean;
  imageJobId?: string;
}
