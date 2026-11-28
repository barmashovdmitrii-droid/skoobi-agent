// @skoobi/channel-telegram — Telegram-канал Скуби как кирпич.
// grammY-канал (TelegramChannel/TelegramMultiBotChannel + host-контракт
// TelegramChannelHost — узкая поверхность ядра, которую инжектит обвязка
// src/channels/telegram.ts) + медиа-глю входящих (photo/audio/video/document
// через Bot API + ffmpeg/mammoth/pdf-parse) + storage-обзор админ-команд.
// Message-plane типы — в @skoobi/shared/channel-types; конфиг-значения —
// ./channel-config (реплика дериваций core-config, .env+cwd).
export * from './telegram.js';
export * from './telegram-bot-config.js';
export * from './photo-telegram.js';
export * from './audio-telegram.js';
export * from './video-telegram.js';
export * from './document-telegram.js';
export * from './admin-storage.js';
