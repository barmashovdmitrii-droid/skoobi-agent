import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FactoryActor } from './game-factory-contracts.js';
import { factoryActorKey } from './game-factory-store.js';
import {
  createGameFactoryAudioAdapter,
  factoryAudioRequestSha256,
  readFactoryAudioConfiguration,
  type FactoryAudioBinding,
  type FactoryAudioConfiguration,
  type FactoryAudioGrant,
  type FactoryAudioHostDependencies,
  type FactoryAudioRecord,
} from './game-factory-audio.js';

const code = process.env.SKOOBI_TEST_LEGACY_FACTORY_ROOT;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const actor: FactoryActor = {
  identityId: 'fixture-actor',
  tenantId: 'fixture-tenant',
  chatJid: 'fixture-chat',
  sourceGroup: 'fixture-main',
  senderId: 'fixture-sender',
  currentMessageIds: ['fixture-message'],
  runId: 'fixture-run',
};
const prompt = 'Gentle original instrumental music — тихий сад, calm game.';
let root: string, configPath: string, controlPath: string, callPath: string;
let config: FactoryAudioConfiguration,
  grant: FactoryAudioGrant,
  db: Database.Database;
let deps: FactoryAudioHostDependencies,
  input: {
    jobId: string;
    projectId: string;
    taskId: string;
    grantId: string;
    prompt: string;
  };
let current = true,
  approval = true;
function write(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}
function grants() {
  write(config.grantsFile, { version: 1, grants: [grant] });
}
function calls(): string[] {
  return fs.existsSync(callPath)
    ? fs.readFileSync(callPath, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}
function row(jobId: string): FactoryAudioRecord | undefined {
  const r = db.prepare('SELECT * FROM audio WHERE job_id=?').get(jobId) as
    | { binding: string; observation?: string; provider_id?: string }
    | undefined;
  return r
    ? {
        binding: JSON.parse(r.binding),
        observation: r.observation ? JSON.parse(r.observation) : undefined,
        providerJobId: r.provider_id ?? undefined,
      }
    : undefined;
}

describe.skipIf(!code)(
  'bounded audio adapter with actual copied Python CLI and synthetic SQLite',
  () => {
    beforeEach(() => {
      root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'factory-audio-')),
      );
      fs.chmodSync(root, 0o700);
      for (const name of ['host', 'state', 'output', 'game'])
        fs.mkdirSync(path.join(root, name), { mode: 0o700 });
      for (const name of ['music.py', 'music_host.py'])
        fs.copyFileSync(path.join(code!, name), path.join(root, 'host', name));
      configPath = path.join(root, 'config.json');
      controlPath = path.join(root, 'control.json');
      callPath = path.join(root, 'calls.txt');
      write(controlPath, {});
      const wrapper = path.join(root, 'host', 'fixture_host.py');
      fs.writeFileSync(
        wrapper,
        `import json,pathlib,sys,wave\nimport music,music_host\nroot=pathlib.Path(__file__).parent.parent\nclass Client:\n def __init__(self,filename): pass\n def credits(self): return 100\n def request(self,method,route,body=None):\n  with (root/'calls.txt').open('a') as f:f.write(method+'\\n')\n  c=json.loads((root/'control.json').read_text())\n  if method=='POST':\n   if c.get('lostAck'):raise music.MusicError('synthetic provider prose never output')\n   return {'jobId':'12345678-1234-4234-8234-123456789abc'}\n  return {'id':'12345678-1234-4234-8234-123456789abc','model':'suno','status':'COMPLETED','result':{'tracks':[{'audioUrl':'https://cdn2.apiframe.ai/fixture-0.mp3'},{'audioUrl':'https://cdn2.apiframe.ai/fixture-1.mp3'}]}}\ndef local_download(url,target):\n with wave.open(str(target),'wb') as f:\n  f.setnchannels(1);f.setsampwidth(2);f.setframerate(8000);f.writeframes(b'\\0\\0'*8000*36)\nmusic.download=local_download\nexecute=music_host.execute\nmusic_host.execute=lambda request:execute(request,client_factory=Client)\nsys.exit(music_host.main())\n`,
        { mode: 0o600 },
      );
      const python = fs.realpathSync(
        execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], {
          encoding: 'utf8',
        }).trim(),
      );
      config = {
        version: 1,
        enabled: true,
        pythonExecutable: python,
        musicScript: wrapper,
        stateDirectory: path.join(root, 'state'),
        outputDirectory: path.join(root, 'output'),
        secretFile: path.join(root, 'absent-secret.env'),
        grantsFile: path.join(root, 'grants.json'),
      };
      write(configPath, config);
      grant = {
        id: 'fixture_grant_01',
        actorKey: factoryActorKey(actor),
        projectId: 'fixture-project',
        taskId: 'fixture-task',
        briefRevision: 1,
        promptSha256: hash(prompt),
        provider: 'apiframe',
        model: 'suno',
        modelVersion: 'V5_5',
        maxCredits: 11,
        estimatedCredits: 11,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        approval: {
          kind: 'host_verified_direct_user',
          approverActorKey: factoryActorKey(actor),
          chatJid: actor.chatJid,
          channelChatId: 'fixture-channel-chat',
          senderId: actor.senderId,
          messageRef: 'fixture-direct-message',
          quote: 'Explicit synthetic approval',
          quoteSha256: hash('Explicit synthetic approval'),
        },
      };
      grants();
      current = true;
      approval = true;
      db = new Database(':memory:');
      db.exec(
        'CREATE TABLE audio(job_id TEXT PRIMARY KEY,grant_id TEXT UNIQUE,binding TEXT NOT NULL,provider_id TEXT,observation TEXT)',
      );
      deps = {
        async authorize(args) {
          if (
            factoryActorKey(args.actor) !== factoryActorKey(actor) ||
            args.projectId !== input.projectId ||
            args.taskId !== input.taskId
          )
            throw new Error('scope denied');
          return {
            actorKey: factoryActorKey(actor),
            projectId: input.projectId,
            taskId: input.taskId,
            briefRevision: 1,
            configurationPath: configPath,
            writableGameRoots: [path.join(root, 'game')],
            requirementsCurrent: current,
          };
        },
        async approvalCurrent() {
          return approval;
        },
        async reserve(binding: FactoryAudioBinding) {
          return db.transaction(() => {
            const existing = row(binding.jobId);
            if (existing) return existing;
            db.prepare(
              'INSERT INTO audio(job_id,grant_id,binding)VALUES(?,?,?)',
            ).run(binding.jobId, binding.grantId, JSON.stringify(binding));
            return { binding };
          })();
        },
        async read(jobId) {
          return row(jobId);
        },
        async observe(jobId, observed) {
          const existing = row(jobId)!;
          if (
            existing.providerJobId &&
            observed.providerJobId &&
            existing.providerJobId !== observed.providerJobId
          )
            throw new Error('provider changed');
          db.prepare(
            'UPDATE audio SET provider_id=COALESCE(provider_id,?),observation=? WHERE job_id=?',
          ).run(
            observed.providerJobId ?? null,
            JSON.stringify(observed),
            jobId,
          );
        },
      };
      input = {
        jobId: randomUUID(),
        projectId: grant.projectId,
        taskId: grant.taskId,
        grantId: grant.id,
        prompt,
      };
    });
    afterEach(() => {
      db?.close();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('defaults disabled; neither model budget nor missing host approval can reserve/spend', async () => {
      const { enabled: _, ...disabled } = config;
      write(configPath, disabled);
      const adapter = createGameFactoryAudioAdapter(deps);
      await expect(adapter.submit(actor, input)).rejects.toThrow(
        'audio_live_disabled',
      );
      write(configPath, config);
      approval = false;
      await expect(adapter.submit(actor, input)).rejects.toThrow(
        'audio_approval_not_host_verified',
      );
      expect(row(input.jobId)).toBeUndefined();
      expect(calls()).toEqual([]);
      expect(fs.readdirSync(config.stateDirectory)).toEqual([]);
    });
    it('actual CLI checks cross-language request hash and sends once after SQLite reservation', async () => {
      const reserve = deps.reserve;
      deps.reserve = async (binding) => {
        expect(calls()).toEqual([]);
        expect(binding.requestSha256).toBe(factoryAudioRequestSha256(prompt));
        return reserve(binding);
      };
      const adapter = createGameFactoryAudioAdapter(deps);
      const first = await adapter.submit(actor, input);
      deps.reserve = reserve;
      const second = await adapter.submit(actor, input);
      expect(first.state).toBe('accepted');
      expect(second).toEqual(first);
      expect(calls()).toEqual(['POST']);
      expect(row(input.jobId)?.providerJobId).toBeDefined();
      for (const value of [
        'private',
        'providerJobId',
        'messageRef',
        'directory',
        'secretFile',
        'prompt',
      ])
        expect(JSON.stringify(first)).not.toContain(value);
    });
    it('unique grant cannot pay a second UUID; lost ACK retains reservation and cannot repost', async () => {
      write(controlPath, { lostAck: true });
      const adapter = createGameFactoryAudioAdapter(deps);
      expect((await adapter.submit(actor, input)).state).toBe('unknown');
      write(controlPath, {});
      expect((await adapter.submit(actor, input)).state).toBe('unknown');
      await expect(
        adapter.submit(actor, { ...input, jobId: randomUUID() }),
      ).rejects.toThrow();
      expect(calls()).toEqual(['POST']);
      expect(row(input.jobId)).toBeDefined();
    });
    it('rechecks revocation/expiry after reserve and before subprocess', async () => {
      const reserve = deps.reserve;
      deps.reserve = async (binding) => {
        const record = await reserve(binding);
        grant.expiresAt = '2000-01-01T00:00:00Z';
        grants();
        return record;
      };
      await expect(
        createGameFactoryAudioAdapter(deps).submit(actor, input),
      ).rejects.toThrow('audio_budget_not_authorized');
      expect(row(input.jobId)).toBeDefined();
      expect(calls()).toEqual([]);
      expect(fs.readdirSync(config.stateDirectory)).toEqual([]);
    });
    it('actor/project/task/prompt grant mismatch and stale currentness fail before reservation', async () => {
      const adapter = createGameFactoryAudioAdapter(deps);
      await expect(
        adapter.submit({ ...actor, identityId: 'other' }, input),
      ).rejects.toThrow('scope denied');
      await expect(
        adapter.submit(actor, { ...input, prompt: prompt + ' changed' }),
      ).rejects.toThrow('audio_budget_not_authorized');
      current = false;
      await expect(adapter.submit(actor, input)).rejects.toThrow(
        'audio_requirements_stale',
      );
      expect(row(input.jobId)).toBeUndefined();
      expect(calls()).toEqual([]);
    });
    it('polls only existing job; disabled/stale project can read scoped local receipt without key', async () => {
      const adapter = createGameFactoryAudioAdapter(deps);
      await adapter.submit(actor, input);
      expect((await adapter.poll(actor, input.jobId)).state).toBe('completed');
      expect(calls()).toEqual(['POST', 'GET']);
      config.enabled = false;
      write(configPath, config);
      current = false;
      const recordBeforeStatus = row(input.jobId);
      const update = deps.observe;
      deps.observe = async () => {
        throw new Error('Readonly status must not mutate registry');
      };
      const status = await adapter.status(actor, input.jobId);
      deps.observe = update;
      expect(row(input.jobId)).toEqual(recordBeforeStatus);
      expect(status.state).toBe('completed');
      expect(status.requirementsCurrent).toBe(false);
      expect(status.cost).toEqual({ status: 'unknown' });
      expect((await adapter.poll(actor, input.jobId)).state).toBe('completed');
      expect(fs.existsSync(config.secretFile)).toBe(false);
      expect(calls()).toEqual(['POST', 'GET']);
    });
    it('does not recreate a lost acknowledged provider receipt or repeat generation', async () => {
      const adapter = createGameFactoryAudioAdapter(deps);
      await adapter.submit(actor, input);
      fs.unlinkSync(
        path.join(config.stateDirectory, input.jobId, 'provider.json'),
      );
      await expect(adapter.status(actor, input.jobId)).rejects.toThrow(
        'audio_provider_receipt_missing',
      );
      await expect(adapter.submit(actor, input)).rejects.toThrow(
        'audio_provider_receipt_missing',
      );
      expect(calls()).toEqual(['POST']);
    });
    it('rejects a substituted journal before provider GET or CDN preparation', async () => {
      const adapter = createGameFactoryAudioAdapter(deps);
      await adapter.submit(actor, input);
      const journal = path.join(
        config.stateDirectory,
        input.jobId,
        'provider.json',
      );
      const state = JSON.parse(fs.readFileSync(journal, 'utf8'));
      write(journal, { ...state, requestSha256: '0'.repeat(64) });
      await expect(adapter.poll(actor, input.jobId)).rejects.toThrow(
        'audio_provider_request_changed',
      );
      await expect(adapter.prepare(actor, input.jobId)).rejects.toThrow(
        'audio_provider_request_changed',
      );
      expect(calls()).toEqual(['POST']);
      expect(fs.readdirSync(config.outputDirectory)).toEqual([]);
    });
    it('private config/grants reject symlinks, hardlinks, shared modes and game-writable runtime', async () => {
      const adapter = createGameFactoryAudioAdapter(deps);
      fs.chmodSync(config.grantsFile, 0o644);
      await expect(adapter.submit(actor, input)).rejects.toThrow(
        'audio_grants_invalid',
      );
      fs.chmodSync(config.grantsFile, 0o600);
      const hard = path.join(root, 'grants-hard.json');
      fs.linkSync(config.grantsFile, hard);
      await expect(adapter.submit(actor, input)).rejects.toThrow(
        'audio_grants_invalid',
      );
      fs.unlinkSync(hard);
      fs.renameSync(config.grantsFile, hard);
      fs.symlinkSync(hard, config.grantsFile);
      await expect(adapter.submit(actor, input)).rejects.toThrow(
        'audio_grants_invalid',
      );
      fs.unlinkSync(config.grantsFile);
      fs.renameSync(hard, config.grantsFile);
      expect(() => readFactoryAudioConfiguration(configPath, [root])).toThrow(
        'audio_runtime_inside_game_workspace',
      );
      expect(calls()).toEqual([]);
    });
    it('prepares a completed result in fresh private output with actual local ffmpeg; accepted game untouched', async () => {
      const adapter = createGameFactoryAudioAdapter(deps);
      const accepted = path.join(root, 'game', 'accepted.mp3');
      fs.writeFileSync(accepted, 'accepted fixture');
      await adapter.submit(actor, input);
      await adapter.poll(actor, input.jobId);
      const first = await adapter.prepare(actor, input.jobId);
      const second = await adapter.prepare(actor, input.jobId);
      expect(first.source.directory).not.toBe(second.source.directory);
      expect(first.source.tracks).toHaveLength(2);
      expect(fs.readFileSync(accepted, 'utf8')).toBe('accepted fixture');
      expect(calls()).toEqual(['POST', 'GET']);
      expect(first.source.cost).toEqual({ status: 'unknown' });
      expect(first.source.rights.status).toBe('needs-provider-confirmation');
    }, 15_000);
  },
);
