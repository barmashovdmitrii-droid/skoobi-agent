import fs from 'fs';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from './config.js';
import { _initTestDatabase, getDb } from './db.js';
import { startIpcWatcher, type IpcDeps } from './ipc.js';

const fixture = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock('./peer-history-service.js', () => ({ handlePeerCodexHistoryWireRequest: fixture.handler }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); getDb().close(); });

it('keeps ordinary delivery responsive while a peer history read is awaiting transport', async () => {
  _initTestDatabase(); vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  fixture.handler.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const folder = 'peer-async-fixture', group = path.join(DATA_DIR, 'ipc', folder);
  fs.mkdirSync(path.join(group, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(group, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(group, 'memory', 'history.request.json'), JSON.stringify({ type: 'peer_codex_history' }));
  fs.writeFileSync(path.join(group, 'messages', 'message.json'), JSON.stringify({ type: 'message', chatJid: 'tg:101', text: 'Synthetic progress' }));
  const route = vi.fn(async (envelope: { text: string }) => envelope.text);
  const deps = { registeredGroups: () => ({ 'tg:101': { name: 'Fixture', folder, trigger: '', added_at: '2026-01-01T00:00:00.000Z' } }),
    router: { route }, registerGroup: vi.fn(),
    syncGroups: vi.fn(), getAvailableGroups: () => [], writeGroupsSnapshot: vi.fn() } as unknown as IpcDeps;
  startIpcWatcher(deps);
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.handler).toHaveBeenCalledOnce();
  expect(route).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(group, 'memory', 'history.request.json'))).toBe(false);
  expect(fs.readdirSync(path.join(group, 'memory'))).toEqual([]);
  finish({ type: 'peer_codex_history_result', request_id: 'fixture_result', ok: false, error: 'history_peer_unavailable' });
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.parse(fs.readFileSync(path.join(group, 'memory', 'fixture_result.result.json'), 'utf8')).error).toBe('history_peer_unavailable');
  fs.rmSync(group, { recursive: true, force: true });
});
