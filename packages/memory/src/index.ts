// @skoobi/memory — память Скуби: файлы groups/<g>/memory (+ shared-user слой).
// Публичный API: loadGroupMemoryContext / loadSharedUserMemoryContext (строка
// контекста для промпта), memoryTopicForFolder / safeSharedMemoryKey (скоупы),
// curateMemoryRoot (кураторская выжимка), createUserMemoryMigrationManifest /
// applyUserMemoryMigrationManifest (миграция legacy-памяти по tenant/identity).
// MCP-инструменты memory_get/save/search живут в agent/runner (ipc-mcp-stdio)
// и работают с теми же файлами; CLI-обвязка — src/scripts/user-memory-*.
export * from './memory-context.js';
export * from './memory-curator.js';
export * from './memory-provenance.js';
export * from './user-memory-migration.js';
