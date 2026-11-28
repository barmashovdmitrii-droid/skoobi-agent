import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import {
  GAME_FACTORY_REJECTIONS,
  GAME_FACTORY_TECHNICAL_ERRORS,
  isToolRejection,
} from './memory-tool-rejection.js';
import { userUpdatePauseText } from './user-update-checkpoint.js';

// J11 (r1111): сторож прислал «game_factory_control: технических ошибок
// 5 из 8», хотя это были штатные отказы завода (newer_user_input_pending) и
// пауза инструмента ради нового сообщения. Отказ по правилам — не поломка.
function call(tool: string, texts: string[], server = 'claudeclaw') {
  return {
    type: 'McpToolCall', server, tool, status: 'failed',
    result: { isError: true, content: texts.map(text => ({ type: 'text', text })) },
  };
}

describe('isToolRejection', () => {
  it('keeps memory_state policy refusals as rejections', () => {
    for (const error of ['revision_conflict', 'project_names_require_direct_source', 'related_project_missing']) {
      expect(isToolRejection(call('memory_state', [JSON.stringify({
        type: 'memory_state_result', ok: false, error,
      })]))).toBe(true);
    }
  });

  it('recognizes input validation only from the named memory tool and the MCP invalid-params boundary', () => {
    const issue = 'Input validation error: Invalid arguments for tool memory_state: invalid field';
    const invalid = 'MCP error -32602: ' + issue;
    expect(isToolRejection(call('memory_state', [invalid]))).toBe(true);
    expect(isToolRejection(call('memory_state_read', [invalid]))).toBe(false);
    expect(isToolRejection(call('memory_state', [invalid], 'another'))).toBe(false);
    expect(isToolRejection(call('memory_state', ['MCP error -32603: ' + issue]))).toBe(false);
    expect(isToolRejection(call('memory_state', ['Storage unavailable. ' + invalid]))).toBe(false);
  });

  it('counts the game factory state and policy refusals as rejections', () => {
    for (const tool of ['game_factory_control', 'game_factory_status']) {
      for (const error of ['newer_user_input_pending', 'writer_lease_mismatch',
        'revision_conflict', 'only_active_project_can_pause', 'operation_not_authorized']) {
        expect(isToolRejection(call(tool, [JSON.stringify({ ok: false, error, currentRevision: 4 })]))).toBe(true);
      }
    }
  });

  it('leaves factory failures, unknown codes and malformed replies as technical errors', () => {
    for (const error of ['factory_request_failed', 'audio_host_unavailable',
      'legacy_cli_unavailable', 'configuration_invalid', 'brand_new_code']) {
      expect(isToolRejection(call('game_factory_control', [JSON.stringify({ ok: false, error })]))).toBe(false);
    }
    expect(isToolRejection(call('game_factory_control', ['Game factory request timed out; execution may still be in progress.']))).toBe(false);
    // A successful-looking body is not a refusal.
    expect(isToolRejection(call('game_factory_control', [JSON.stringify({ ok: true, error: 'newer_user_input_pending' })]))).toBe(false);
    // The factory code is honoured only from our own server and the factory tools.
    expect(isToolRejection(call('game_factory_control', [JSON.stringify({ ok: false, error: 'newer_user_input_pending' })], 'another'))).toBe(false);
    expect(isToolRejection(call('send_message', [JSON.stringify({ ok: false, error: 'newer_user_input_pending' })]))).toBe(false);
  });

  it('counts the checkpoint pause of any own tool as a rejection, not a failure', () => {
    const updates = JSON.stringify({ kind: 'pending_user_updates', updates: [] });
    expect(isToolRejection(call('game_factory_control', [updates, userUpdatePauseText('game_factory_control')]))).toBe(true);
    expect(isToolRejection(call('send_document', [updates, userUpdatePauseText('send_document')]))).toBe(true);
    // The pause text must name this very tool and come from our server.
    expect(isToolRejection(call('send_document', [updates, userUpdatePauseText('computer_click')]))).toBe(false);
    expect(isToolRejection(call('send_document', [updates, userUpdatePauseText('send_document')], 'another'))).toBe(false);
    // Tool output that merely quotes the sentence is not the checkpoint.
    expect(isToolRejection(call('send_document', [`echo: ${userUpdatePauseText('send_document')}`]))).toBe(false);
  });
});

// J11-2: отказы по состоянию и правилам (reconcile до подтверждения конца
// прошлого запуска, релиз вне брифа…) считались техническими ошибками.
describe('J11-2: every game factory code is classified', () => {
  const orchestrator = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../packages/core/src/orchestrator',
  );
  const codes = (file: string, pattern: RegExp): string[] =>
    [...fs.readFileSync(path.join(orchestrator, file), 'utf8').matchAll(pattern)]
      .map((match) => match[1]);
  const thrown = new Set([
    ...['game-factory-service.ts', 'game-factory-store.ts'].flatMap((file) =>
      codes(file, /FactoryError\(\s*['"]([a-z0-9_]+)['"]/g)),
    // Codes chosen by a condition inside FactoryError(…).
    ...codes('game-factory-service.ts', /FactoryError\([^;]*?\?\s*'([a-z0-9_]+)'\s*:\s*'[a-z0-9_]+'/g),
    ...codes('game-factory-service.ts', /FactoryError\([^;]*?\?\s*'[a-z0-9_]+'\s*:\s*'([a-z0-9_]+)'/g),
    // Codes of the boundary itself.
    ...codes('game-factory-authorization.ts', /error:\s*'([a-z0-9_]+)'/g),
  ]);

  it('each code thrown by the service, the store or the boundary is a rejection or a technical error', () => {
    expect(thrown.size).toBeGreaterThan(100);
    const undecided = [...thrown].filter(
      (code) => !GAME_FACTORY_REJECTIONS.has(code) && !GAME_FACTORY_TECHNICAL_ERRORS.has(code),
    );
    expect(undecided).toEqual([]);
    const both = [...GAME_FACTORY_REJECTIONS].filter((code) => GAME_FACTORY_TECHNICAL_ERRORS.has(code));
    expect(both).toEqual([]);
  });

  it('state and rule refusals are rejections; unavailable, failed, changed and configuration stay errors', () => {
    for (const error of ['previous_execution_not_confirmed_finished', 'execution_not_reconciled',
      'peer_execution_not_finished', 'peer_task_already_dispatched', 'technical_evidence_required',
      'review_has_unresolved_evidence', 'release_not_prepared', 'platform_outside_brief',
      'roblox_place_capture_required', 'roblox_place_entrypoint_required', 'roblox_playtest_report_invalid',
      'roblox_two_client_report_required', 'lease_reconciliation_required', 'writer_already_claimed']) {
      expect(thrown.has(error)).toBe(true);
      expect(isToolRejection(call('game_factory_control', [JSON.stringify({ ok: false, error })]))).toBe(true);
    }
    // Codes from the artifact worker and older installed peers are still valid refusals.
    for (const error of ['roblox_place_missing','roblox_place_invalid','roblox_playtest_report_mismatch','roblox_requires_studio_verification']) {
      expect(isToolRejection(call('game_factory_control', [JSON.stringify({ ok: false, error })]))).toBe(true);
    }
    for (const error of [...GAME_FACTORY_TECHNICAL_ERRORS]) {
      expect(isToolRejection(call('game_factory_control', [JSON.stringify({ ok: false, error })]))).toBe(false);
    }
    for (const error of [...thrown]) {
      if (/_unavailable$|_failed$|_changed$|^configuration_/.test(error)) {
        expect(GAME_FACTORY_TECHNICAL_ERRORS.has(error)).toBe(true);
      }
    }
  });
});
