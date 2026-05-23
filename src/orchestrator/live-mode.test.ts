import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildLiveModelRequest } from './live-mode.js';
import type { RegisteredGroup } from './types.js';
import type { TenantRecord } from './tenant-registry.js';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  createdDirs.length = 0;
});

function tenant(folder: string): TenantRecord {
  const group: RegisteredGroup = {
    name: 'Customer',
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  };
  return {
    tenant_id: `wa_chat_${folder}`,
    folder,
    channel: 'whatsapp',
    chat_id: '77010000000',
    mode: 'guest',
    runtime: 'claude_sdk',
    approved_senders: [],
    models: {},
    quota: { enabled: false },
    legacy_jid: 'wa:77010000000',
    source: 'legacy_registered_group',
    group,
  };
}

describe('buildLiveModelRequest', () => {
  it('injects inherited tenant instructions into the live model prompt', () => {
    const parentFolder = `live_test_${Date.now()}`;
    const childFolder = `${parentFolder}__wa_77010000000`;
    const parentDir = path.join(process.cwd(), 'groups', parentFolder);
    const childDir = path.join(process.cwd(), 'groups', childFolder);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    createdDirs.push(parentDir, childDir);
    fs.writeFileSync(
      path.join(parentDir, 'instructions.md'),
      'Отвечай клиентам коротко на русском.',
    );

    const request = buildLiveModelRequest({
      tenant: tenant(childFolder),
      prompt: '<messages />',
    });

    expect(request.messages[0].content).toContain(
      'Отвечай клиентам коротко на русском.',
    );
    expect(request.messages[0].content).toContain('source="instructions.md"');
  });
});
