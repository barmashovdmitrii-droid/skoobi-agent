/**
 * Скуби-панель — сборка (волна Д1 плана панели, 2026-07-07).
 * Локальный веб-интерфейс мониторинга и управления модулями.
 *
 * Запуск (launchd com.skoobi.dashboard):
 *   node <монорепо>/apps/dashboard/dist/service.js
 *   WorkingDirectory = каталог инстанса (панель читает store/, logs/, data/,
 *   .env этого инстанса — STATE_ROOT=cwd, как у всех сборок Скуби).
 *
 * Безопасность: слушает только 127.0.0.1; без SKOOBI_DASHBOARD_TOKEN в .env
 * данные не отдаются; действия — жёсткий allowlist с аудитом.
 */
import { startDashboard } from '@skoobi/dashboard';

startDashboard();
