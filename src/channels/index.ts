// Built-in channel imports — self-registering on import.
import './telegram.js';
// WhatsApp-канал (кирпич @skoobi/channel-whatsapp, обвязка в пакете —
// './wiring' с волны 9a) включается ПО ФЛАГУ ИНСТАНСА, а не правкой кода:
// SKOOBI_WHATSAPP_CHANNEL_ENABLED=true в .env + учётка Baileys в store/auth
// (auth-CLI: npm run auth:whatsapp из корня инстанса). Без флага модуль не
// загружается, поэтому Telegram-only остаётся безопасным поведением по
// умолчанию.
import { readEnvFile } from '@skoobi/shared/env';

const whatsappEnv = readEnvFile(['SKOOBI_WHATSAPP_CHANNEL_ENABLED']);
if (
  /^(?:1|true|yes|on)$/i.test(
    (
      process.env.SKOOBI_WHATSAPP_CHANNEL_ENABLED ||
      whatsappEnv.SKOOBI_WHATSAPP_CHANNEL_ENABLED ||
      ''
    ).trim(),
  )
) {
  await import('./whatsapp.js');
}
