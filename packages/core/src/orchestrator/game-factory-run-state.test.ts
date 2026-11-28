import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FactoryActor,
  FactoryConfiguration,
} from './game-factory-contracts.js';
import { ensureGameFactorySchema } from './game-factory-store.js';
import {
  createFactoryHostRunLifecycle,
  inspectFactoryHostRun,
  observeFactoryHostRun,
} from './game-factory-run-state.js';

let temp: string, filename: string;
let config: Pick<FactoryConfiguration, 'enabled' | 'databasePath' | 'actors'>;
const actor = (): FactoryActor => ({
  identityId: 'synthetic-actor',
  tenantId: 'synthetic-tenant',
  chatJid: 'tg:synthetic',
  sourceGroup: 'synthetic-group',
  senderId: 'synthetic-sender',
  currentMessageIds: ['synthetic-message'],
  runId: randomUUID(),
});
const errors = vi.fn();
const lifecycle = () =>
  createFactoryHostRunLifecycle({
    readConfiguration: () => config,
    validateDatabaseLocation: (file) => fs.existsSync(file),
    onPersistenceError: errors,
  });
function createDatabase(schema = true) {
  const db = new Database(filename);
  if (schema) ensureGameFactorySchema(db);
  db.close();
  fs.chmodSync(filename, 0o600);
}
function read(runId: string) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    return inspectFactoryHostRun(db, runId);
  } finally {
    db.close();
  }
}
beforeEach(() => {
  temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-run-state-')),
  );
  filename = path.join(temp, 'factory.db');
  config = {
    enabled: true,
    databasePath: filename,
    actors: [
      {
        identityId: 'synthetic-actor',
        tenantId: 'synthetic-tenant',
        alias: 'synthetic',
        canCreate: true,
        backends: ['agent'],
        sourceRoots: [temp],
      },
    ],
  };
  errors.mockClear();
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('durable factory host completion', () => {
  it('survives a clean connection reload but started-only crash state stays unknown', () => {
    createDatabase();
    const closed = actor(),
      crashed = actor(),
      attempt = randomUUID();
    const finish = lifecycle()(closed, attempt)!;
    lifecycle()(crashed, attempt); // имитация процесса без finally
    expect(read(closed.runId)).toEqual({
      state: 'unknown',
      reason: 'host_completion_missing_after_restart',
    });
    finish();
    finish();
    expect(read(closed.runId)).toEqual({
      state: 'finished',
      reason: 'durable_host_finally',
    });
    expect(read(crashed.runId)).toEqual({
      state: 'unknown',
      reason: 'host_completion_missing_after_restart',
    });
    const db = new Database(filename, { readonly: true });
    expect(observeFactoryHostRun(db, crashed.runId, 'active')).toBe('active');
    expect(observeFactoryHostRun(db, closed.runId, 'active')).toBe('active');
    const rows = db.prepare('SELECT * FROM factory_host_runs').all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(
      /synthetic-actor|synthetic-message|synthetic-sender/,
    );
    db.close();
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not create missing database or schema, but persists finally after first create', () => {
    const a = actor(),
      finish = lifecycle()(a, randomUUID())!;
    expect(fs.existsSync(filename)).toBe(false);
    createDatabase();
    finish();
    expect(read(a.runId).state).toBe('finished');
    const other = path.join(temp, 'empty.db');
    config.databasePath = other;
    const empty = new Database(other);
    empty.close();
    const finishWithoutSchema = lifecycle()(actor())!;
    finishWithoutSchema();
    const db = new Database(other, { readonly: true });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
    ).toEqual([]);
    expect(observeFactoryHostRun(db, randomUUID())).toBe('unknown');
    db.close();
  });

  it('scopes the captured callback to the configured actor and database', () => {
    createDatabase();
    const a = actor(),
      finish = lifecycle()(a)!;
    const denied = lifecycle()({ ...actor(), tenantId: 'different-tenant' });
    expect(denied).toBeUndefined();
    config = { ...config, enabled: false };
    finish();
    expect(read(a.runId).state).toBe('finished');
    config.enabled = true;
    const b = actor(),
      finishMoved = lifecycle()(b)!;
    config.databasePath = path.join(temp, 'different.db');
    finishMoved();
    expect(fs.existsSync(config.databasePath)).toBe(false);
    expect(read(b.runId).state).toBe('unknown');
  });

  it('does not infer finished from elapsed time or diagnostic attempt reuse', () => {
    createDatabase();
    const a = actor(),
      b = actor(),
      attempt = randomUUID();
    const doneA = lifecycle()(a, attempt)!;
    lifecycle()(b, attempt);
    doneA();
    const db = new Database(filename);
    db.prepare(
      "UPDATE factory_host_runs SET started_at='2000-01-01T00:00:00.000Z' WHERE invocation_run_id=?",
    ).run(b.runId);
    expect(observeFactoryHostRun(db, a.runId)).toBe('finished');
    expect(observeFactoryHostRun(db, b.runId)).toBe('unknown');
    db.close();
  });

  it('fails closed on a mismatched binding and reports only the persistence phase', () => {
    createDatabase();
    const a = actor(),
      finish = lifecycle()(a)!;
    const db = new Database(filename);
    db.prepare(
      'UPDATE factory_host_runs SET host_instance_id=? WHERE invocation_run_id=?',
    ).run(randomUUID(), a.runId);
    db.close();
    finish();
    expect(read(a.runId).state).toBe('unknown');
    expect(errors).toHaveBeenCalledExactlyOnceWith('finished');
  });
});
