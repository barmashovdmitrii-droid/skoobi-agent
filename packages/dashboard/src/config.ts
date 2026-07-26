import path from 'path';

import { readEnvFile } from '@skoobi/shared/env';

// Панель живёт по правилам инстансов Скуби: state = cwd. Панель мониторит
// тот инстанс, из чьей папки запущена (WorkingDirectory в launchd-плисте).
export const STATE_ROOT = process.cwd();
export const STORE_DIR = path.join(STATE_ROOT, 'store');
export const LOG_FILE = path.join(STATE_ROOT, 'logs', 'claudeclaw.log');
export const ACTIONS_LOG_FILE = path.join(
  STATE_ROOT,
  'logs',
  'dashboard-actions.log',
);
export const ACCESS_CONTROL_FILE = path.join(
  STATE_ROOT,
  'data',
  'telegram-access-control.json',
);
export const ENV_FILE = path.join(STATE_ROOT, '.env');

export type DashboardConfig = {
  port: number;
  host: string;
  token: string | null;
};

// Порт и токен читаются из .env инстанса (как все SKOOBI_*-настройки).
// Токена нет → сервер стартует, но отвечает только страницей с инструкцией,
// НИКОГДА не отдаёт данные: отсутствие токена не должно молча открыть панель.
export function loadDashboardConfig(): DashboardConfig {
  const env = readEnvFile(['SKOOBI_DASHBOARD_PORT', 'SKOOBI_DASHBOARD_TOKEN']);
  const rawPort =
    process.env.SKOOBI_DASHBOARD_PORT || env.SKOOBI_DASHBOARD_PORT || '';
  const parsed = Number.parseInt(rawPort, 10);
  const port =
    Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 8801;
  const token = (
    process.env.SKOOBI_DASHBOARD_TOKEN ||
    env.SKOOBI_DASHBOARD_TOKEN ||
    ''
  ).trim();
  return {
    port,
    // Только loopback. Внешний доступ включается отдельным осознанным
    // решением, а не правкой безопасного дефолта.
    host: '127.0.0.1',
    token: token.length >= 16 ? token : null,
  };
}
