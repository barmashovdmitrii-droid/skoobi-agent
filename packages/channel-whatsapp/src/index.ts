// Публичный API кирпича @skoobi/channel-whatsapp (волна 7d).
// Канал возвращён из git-истории (66e02ec^) на пакетную раскладку по образцу
// @skoobi/channel-telegram: ядровые зависимости — через инжектируемый
// WhatsAppChannelHost (обвязка src/channels/whatsapp.ts), типы message-plane —
// из @skoobi/shared/channel-types. Auth-CLI: src/whatsapp-auth.ts (не
// экспортируется — самозапускается при импорте; гонять через npm run auth).
export {
  WhatsAppChannel,
  type WhatsAppChannelHost,
  type WhatsAppChannelOpts,
  type WhatsAppObservedContentType,
  type WhatsAppObservedEventType,
  type WhatsAppObserverMediaBackfillProgress,
  type WhatsAppObservedMessage,
  type WhatsAppRegisteredGroup,
} from './whatsapp.js';
export {
  STORE_DIR,
  WHATSAPP_PERSONAL_OBSERVER,
  WHATSAPP_STATE_ROOT,
  type WhatsAppPersonalObserverConfig,
} from './channel-config.js';
export {
  downloadWhatsappMedia,
  type DownloadedMedia,
  type WhatsappMediaKind,
} from './whatsapp-media.js';
export {
  createWhatsappVideoProcessor,
  processDownloadedWhatsappVideo,
  whatsappVideoFrameTimes,
  type WhatsappVideoAnalysisResult,
  type WhatsappVideoExec,
  type WhatsappVideoProcessorOptions,
  type WhatsappVideoSkipReason,
} from './whatsapp-video.js';
