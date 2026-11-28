// Обвязка WhatsApp-канала переехала в пакет (волна 9a, 2026-07-07):
// @skoobi/channel-whatsapp/wiring. Импорт side-effect'ом регистрирует канал.
// channels/index.ts импортирует этот файл только при явном
// SKOOBI_WHATSAPP_CHANNEL_ENABLED=true; без флага пакет не загружается.
import '@skoobi/channel-whatsapp/wiring';
