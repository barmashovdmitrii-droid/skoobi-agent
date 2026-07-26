import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from './config.js';

// Панель НЕ вызывает initDatabase() ядра: миграции/бэкфилл/JSON-импорт — это
// write-side-effects на живой БД бота из второго процесса, им тут не место
// (схему уже создал бот). Панель открывает СВОИ соединения к тому же файлу:
// read-only для экранов и rw только для действий с задачами. fileMustExist —
// если файла нет, значит бот ещё не поднимался: честная ошибка вместо
// создания пустой БД.

const DB_PATH = path.join(STORE_DIR, 'messages.db');

let readHandle: Database.Database | null = null;
let writeHandle: Database.Database | null = null;

export function readDb(): Database.Database {
  if (!readHandle) {
    readHandle = new Database(DB_PATH, {
      readonly: true,
      fileMustExist: true,
    });
    readHandle.pragma('busy_timeout = 4000');
  }
  return readHandle;
}

export function writeDb(): Database.Database {
  if (!writeHandle) {
    writeHandle = new Database(DB_PATH, { fileMustExist: true });
    writeHandle.pragma('busy_timeout = 5000');
    writeHandle.pragma('foreign_keys = ON');
  }
  return writeHandle;
}
