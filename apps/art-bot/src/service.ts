/**
 * Optional Skoobi image-bot assembly. It combines the core runtime and
 * Telegram channel; image generation is enabled and configured per instance.
 *
 * Run:
 *   node <repository>/apps/art-bot/dist/service.js
 * with WorkingDirectory set to the instance directory. Runtime state
 * (store/, groups/, .env, logs/) lives in that working directory.
 *
 * Порядок загрузки повторяет корневой service.ts: каналы → встроенные
 * extensions → устанавливаемые extensions → message-loop.
 */
import { loadExtensions } from '@skoobi/core/extension-loader';

async function start(): Promise<void> {
  // Канал: только Telegram (саморегистрация side-effect'ом импорта wiring).
  await import('@skoobi/channel-telegram/wiring');

  // Встроенные extensions ядра (учёт стоимости агент-ранов, webhook-схема).
  await import('@skoobi/core/cost-tracking');
  await import('@skoobi/core/webhook');

  // Load optional extensions from the configured code root.
  await loadExtensions();

  const { main } = await import('@skoobi/core/message-loop');
  await main();
}

start().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
