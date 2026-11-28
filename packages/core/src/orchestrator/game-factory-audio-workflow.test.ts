import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import { executeGameFactoryRequest } from './game-factory-service.js';
import { factoryActorKey } from './game-factory-store.js';
import type {
  FactoryActor,
  FactoryConfiguration,
  FactoryProject,
  FactoryRequest,
} from './game-factory-contracts.js';
import type {
  FactoryAudioConfiguration,
  FactoryAudioGrant,
} from './game-factory-audio.js';
const legacy = process.env.SKOOBI_TEST_LEGACY_FACTORY_ROOT;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const brief = {
  goal: 'Create a small original game',
  audience: 'Players',
  firstSession: 'Learn one action',
  coreLoop: 'Collect and finish',
  artDirection: 'Calm garden',
  acceptance: ['A complete loop'],
  devices: ['desktop'],
  platforms: ['crazygames'],
};
const prompt = 'Original gentle instrumental music for a small garden game.';
const quote =
  'Synthetic explicit approval for exactly one music request up to 11 credits.';
let root: string,
  config: FactoryConfiguration,
  audio: FactoryAudioConfiguration,
  grant: FactoryAudioGrant,
  actor: FactoryActor,
  project: FactoryProject | undefined,
  counter: number,
  token: string;
const write = (p: string, value: unknown) =>
  fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 });
function message(id: string, content: string, who = actor) {
  storeChatMetadata(who.chatJid, new Date().toISOString());
  storeMessage({
    id,
    chat_jid: who.chatJid,
    sender: who.senderId,
    sender_name: 'Synthetic',
    content,
    timestamp: new Date().toISOString(),
    is_bot_message: false,
    sender_identity: {
      channel: 'telegram',
      chat_id: who.channelChatId!,
      telegram_user_id: who.senderId,
      identity_id: who.identityId,
      telegram_message_origin: 'direct',
      is_owner_sender: true,
    },
  });
}
function request(
  action: string,
  args: Record<string, unknown> = {},
): FactoryRequest {
  return {
    action,
    args,
    operationId: `audio-workflow-${++counter}`,
    projectId: 'audio-game',
    expectedRevision: project?.revision ?? 0,
  };
}
async function call(
  action: string,
  args: Record<string, unknown> = {},
  who = actor,
): Promise<Record<string, any>> {
  const result = (await executeGameFactoryRequest(
    who,
    request(action, args),
  )) as Record<string, any>;
  if (result.project) project = result.project;
  return result;
}
function calls() {
  const f = path.join(root, 'calls.txt');
  return fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}
function control(value: unknown) {
  write(path.join(root, 'control.json'), value);
}
function bindings() {
  const db = new Database(config.databasePath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM factory_audio_bindings').all() as Array<
      Record<string, any>
    >;
  } finally {
    db.close();
  }
}

describe.skipIf(!legacy)(
  'canonical service paid audio without provider network or real credentials',
  () => {
    beforeEach(async () => {
      _initTestDatabase();
      root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'factory-audio-workflow-')),
      );
      fs.chmodSync(root, 0o700);
      for (const folder of ['work', 'source', 'host', 'state', 'output'])
        fs.mkdirSync(path.join(root, folder), { mode: 0o700 });
      for (const name of ['music.py', 'music_host.py'])
        fs.copyFileSync(
          path.join(legacy!, name),
          path.join(root, 'host', name),
        );
      const wrapper = path.join(root, 'host', 'fixture_host.py');
      fs.writeFileSync(
        wrapper,
        `import json,pathlib,sys,time,wave\nimport music,music_host\nroot=pathlib.Path(__file__).parent.parent\nclass Client:\n def __init__(self,filename):pass\n def credits(self):return 100\n def request(self,method,route,body=None):\n  with (root/'calls.txt').open('a') as f:f.write(method+'\\n')\n  c=json.loads((root/'control.json').read_text())\n  if method=='POST':\n   if c.get('holdAck'):\n    (root/'entered').write_text('accepted synthetic POST')\n    deadline=time.monotonic()+10\n    while not (root/'release').exists() and time.monotonic()<deadline:time.sleep(0.02)\n   if c.get('lostAck'):raise music.MusicError('synthetic lost ACK')\n   return {'jobId':'12345678-1234-4234-8234-123456789abc'}\n  return {'id':'12345678-1234-4234-8234-123456789abc','model':'suno','status':'COMPLETED','result':{'tracks':[{'audioUrl':'https://cdn2.apiframe.ai/0.mp3'},{'audioUrl':'https://cdn2.apiframe.ai/1.mp3'}]}}\ndef local_download(url,target):\n with wave.open(str(target),'wb') as f:\n  f.setnchannels(1);f.setsampwidth(2);f.setframerate(8000);f.writeframes(b'\\0\\0'*8000*36)\nmusic.download=local_download\nexecute=music_host.execute\nmusic_host.execute=lambda q:execute(q,client_factory=Client)\nsys.exit(music_host.main())\n`,
        { mode: 0o600 },
      );
      actor = {
        identityId: 'audio-owner',
        tenantId: 'audio-tenant',
        chatJid: 'tg:audio-fixture-chat',
        channelChatId: 'audio-fixture-chat',
        sourceGroup: 'fixture-main',
        senderId: 'audio-fixture-owner',
        currentMessageIds: ['approve-and-start'],
        runId: 'audio-fixture-run',
        isPrimaryOwner: true,
      };
      config = {
        version: 1,
        enabled: true,
        primaryOwnerIdentityId: actor.identityId,
        databasePath: path.join(root, 'factory.db'),
        workspaceRoot: path.join(root, 'work'),
        actors: [
          {
            identityId: actor.identityId,
            tenantId: actor.tenantId,
            alias: 'owner',
            canCreate: true,
            backends: ['agent'],
            sourceRoots: [path.join(root, 'source')],
          },
        ],
        audio: { configurationPath: path.join(root, 'audio.json') },
      };
      audio = {
        version: 1,
        enabled: true,
        pythonExecutable: fs.realpathSync(
          execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], {
            encoding: 'utf8',
          }).trim(),
        ),
        musicScript: wrapper,
        stateDirectory: path.join(root, 'state'),
        outputDirectory: path.join(root, 'output'),
        secretFile: path.join(root, 'absent-secret.env'),
        grantsFile: path.join(root, 'grants.json'),
      };
      grant = {
        id: 'fixture_audio_grant',
        actorKey: factoryActorKey(actor),
        projectId: 'audio-game',
        taskId: 'music-task',
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
          channelChatId: actor.channelChatId!,
          senderId: actor.senderId,
          messageRef: 'approve-and-start',
          quote,
          quoteSha256: hash(quote),
        },
      };
      write(path.join(root, 'config.json'), config);
      write(config.audio!.configurationPath, audio);
      write(audio.grantsFile, { version: 1, grants: [grant] });
      control({});
      vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', path.join(root, 'config.json'));
      counter = 0;
      project = undefined;
      message('approve-and-start', quote);
      await call('create', {
        title: 'Synthetic music game',
        engine: 'canvas',
        brief,
      });
      await call('plan', {
        tasks: [
          {
            id: 'music-task',
            stage: 'art',
            title: 'Music candidate',
            acceptance: ['Original instrumental candidate'],
            dependencies: [],
          },
        ],
      });
      token = (await call('claim', { taskId: 'music-task', backend: 'agent' }))
        .claim.token;
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('reserves once before POST, replays, reads without writes and imports exact MP3 as candidates', async () => {
      const dispatch = request('audio_dispatch', {
        token,
        grantId: grant.id,
        prompt,
      });
      const first = (await executeGameFactoryRequest(actor, dispatch)) as any;
      project = first.project;
      expect(first.observation.state).toBe('accepted');
      expect(first.paidGenerationAccepted).toBe(true);
      expect(bindings()).toHaveLength(1);
      expect(calls()).toEqual(['POST']);
      const second = (await executeGameFactoryRequest(actor, dispatch)) as any;
      expect(second.audioJobId).toBe(first.audioJobId);
      expect(calls()).toEqual(['POST']);
      const before = bindings();
      const bytes = fs.readFileSync(config.databasePath);
      expect(
        (await call('audio_status', { jobId: first.audioJobId })).state,
      ).toBe('accepted');
      expect(bindings()).toEqual(before);
      expect(fs.readFileSync(config.databasePath)).toEqual(bytes);
      await call('audio_refresh', { jobId: first.audioJobId });
      const imported = await call('audio_import', { jobId: first.audioJobId });
      expect(imported.assets).toHaveLength(2);
      expect(imported.assets.every((a: any) => a.state === 'candidate')).toBe(
        true,
      );
      expect(imported.providerCost).toEqual({ status: 'unknown' });
      expect(imported.rights.status).toBe('needs-provider-confirmation');
      for (const asset of imported.assets) {
        const file = path.join(project!.workspace, asset.relativePath);
        expect(
          createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        ).toBe(asset.file.sha256);
      }
      const again = await call('audio_import', { jobId: first.audioJobId });
      expect(again.assets.map((a: any) => a.id)).toEqual(
        imported.assets.map((a: any) => a.id),
      );
      expect(calls()).toEqual(['POST', 'GET']);
      expect(fs.existsSync(audio.secretFile)).toBe(false);
    }, 20_000);
    it('rejects forged approval provenance and model budget without reserving or reading secrets', async () => {
      grant.approval.messageRef = 'does-not-exist';
      write(audio.grantsFile, { version: 1, grants: [grant] });
      await expect(
        call('audio_dispatch', { token, grantId: grant.id, prompt }),
      ).rejects.toThrow('audio_approval_not_host_verified');
      await expect(
        call('audio_dispatch', {
          token,
          grantId: grant.id,
          prompt,
          budget: 100,
        }),
      ).rejects.toThrow('invalid_input');
      expect(bindings()).toEqual([]);
      expect(calls()).toEqual([]);
      expect(fs.readdirSync(audio.stateDirectory)).toEqual([]);
    });
    it('does not spend an agent grant through another executor claim', async () => {
      await call('release_claim', { token });
      config.actors[0].backends.push('legacy');
      config.legacy = {
        configurationPath: path.join(root, 'not-enabled-legacy.json'),
      };
      write(path.join(root, 'config.json'), config);
      token = (await call('claim', { taskId: 'music-task', backend: 'legacy' }))
        .claim.token;
      await expect(
        call('audio_dispatch', { token, grantId: grant.id, prompt }),
      ).rejects.toThrow('audio_backend_not_allowed');
      expect(bindings()).toEqual([]);
      expect(calls()).toEqual([]);
    });
    it('preserves an unknown submission reservation and never pays the grant twice', async () => {
      control({ lostAck: true });
      const dispatch = request('audio_dispatch', {
        token,
        grantId: grant.id,
        prompt,
      });
      const first = (await executeGameFactoryRequest(actor, dispatch)) as any;
      project = first.project;
      expect(first.observation.state).toBe('unknown');
      expect(first.paidGenerationAccepted).toBeNull();
      control({});
      expect(
        ((await executeGameFactoryRequest(actor, dispatch)) as any).observation
          .state,
      ).toBe('unknown');
      await expect(
        call('audio_dispatch', { token, grantId: grant.id, prompt }),
      ).rejects.toThrow('audio_grant_already_reserved');
      expect(bindings()).toHaveLength(1);
      expect(calls()).toEqual(['POST']);
    });
    it('late correction preserves provider ACK but blocks old conversational result and current acceptance', async () => {
      control({ holdAck: true });
      const pending = call('audio_dispatch', {
        token,
        grantId: grant.id,
        prompt,
      });
      await vi.waitFor(
        () => expect(fs.existsSync(path.join(root, 'entered'))).toBe(true),
        { timeout: 4000, interval: 20 },
      );
      message(
        'new-correction',
        'Change the game direction; do not treat old music as the new brief.',
      );
      fs.writeFileSync(path.join(root, 'release'), 'continue');
      await expect(pending).rejects.toThrow('newer_user_input_pending');
      const binding = bindings()[0];
      expect(binding.provider_job_id).toBeDefined();
      expect(calls()).toEqual(['POST']);
      actor.currentMessageIds = ['new-correction'];
      project = (await call('inspect')).project;
      await call('brief', { ...brief, goal: 'A corrected direction' });
      await call('audio_refresh', { jobId: binding.job_id });
      const imported = await call('audio_import', { jobId: binding.job_id });
      expect(imported.requirementsCurrent).toBe(false);
      await expect(
        call('asset_review', {
          assetId: imported.assets[0].id,
          state: 'accepted',
          note: 'Try stale acceptance',
        }),
      ).rejects.toThrow('asset_requirements_stale');
      expect(calls()).toEqual(['POST', 'GET']);
    }, 20_000);
    it('expired grants and disabled new spending retain already-paid retrieval; explicit grant removal revokes it', async () => {
      const first = await call('audio_dispatch', {
        token,
        grantId: grant.id,
        prompt,
      });
      audio.enabled = false;
      write(config.audio!.configurationPath, audio);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 7200_000);
      expect(
        (await call('audio_status', { jobId: first.audioJobId })).state,
      ).toBe('accepted');
      await call('audio_refresh', { jobId: first.audioJobId });
      expect(
        (await call('audio_import', { jobId: first.audioJobId })).assets,
      ).toHaveLength(2);
      audio.enabled = true;
      write(config.audio!.configurationPath, audio);
      await expect(
        call('audio_dispatch', { token, grantId: grant.id, prompt }),
      ).rejects.toThrow();
      write(audio.grantsFile, { version: 1, grants: [] });
      await expect(
        call('audio_status', { jobId: first.audioJobId }),
      ).rejects.toThrow('audio_budget_not_authorized');
      expect(calls()).toEqual(['POST', 'GET']);
    }, 20_000);
    it('preserves a late paid receipt but discloses no result when the grant is revoked during POST', async () => {
      control({ holdAck: true });
      const pending = call('audio_dispatch', {
        token,
        grantId: grant.id,
        prompt,
      });
      await vi.waitFor(
        () => expect(fs.existsSync(path.join(root, 'entered'))).toBe(true),
        { timeout: 4000, interval: 20 },
      );
      write(audio.grantsFile, { version: 1, grants: [] });
      fs.writeFileSync(path.join(root, 'release'), 'continue');
      await expect(pending).rejects.toThrow('audio_budget_not_authorized');
      expect(bindings()[0].provider_job_id).toBeDefined();
      expect(calls()).toEqual(['POST']);
      await expect(
        call('audio_status', { jobId: bindings()[0].job_id }),
      ).rejects.toThrow('audio_budget_not_authorized');
    });
    it('does not disclose a foreign project or an unbound job to a configured second administrator', async () => {
      const first = await call('audio_dispatch', {
        token,
        grantId: grant.id,
        prompt,
      });
      const second = {
        ...actor,
        identityId: 'audio-second',
        tenantId: 'audio-second-tenant',
        senderId: 'audio-second-sender',
        chatJid: 'tg:audio-second',
        channelChatId: 'audio-second',
        currentMessageIds: ['second-message'],
        runId: 'second-run',
      };
      config.actors.push({
        identityId: second.identityId,
        tenantId: second.tenantId,
        alias: 'second',
        canCreate: true,
        backends: ['agent'],
        sourceRoots: [],
      });
      write(path.join(root, 'config.json'), config);
      message('second-message', 'Read the shared game.', second);
      await expect(
        call('audio_status', { jobId: first.audioJobId }, second),
      ).rejects.toThrow();
      await call('share', { alias: 'second', role: 'editor' });
      expect(
        (await call('audio_status', { jobId: first.audioJobId }, second)).state,
      ).toBe('accepted');
      await expect(
        call('audio_status', { jobId: randomUUID() }, second),
      ).rejects.toThrow('audio_binding_unavailable');
      expect(calls()).toEqual(['POST']);
    });
  },
);
