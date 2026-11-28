// @skoobi/dashboard — локальная веб-панель Скуби (мониторинг + управление
// модулями). Слушает только 127.0.0.1, вход по токену, действия — по
// жёсткому allowlist с аудитом в logs/dashboard-actions.log.
export { startDashboard, createDashboardServer } from './server.js';
export { loadDashboardConfig } from './config.js';
