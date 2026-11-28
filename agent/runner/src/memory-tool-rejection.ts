import { userUpdatePauseText } from './user-update-checkpoint.js';

/** Only recognized structured memory refusals are non-technical outcomes.
 * Unknown errors, transport failures and malformed replies remain failures. */
const MEMORY_REJECTIONS = new Set([
  "activation_required",
  "card_too_large",
  "credential_content",
  "current_direct_source_required",
  "detail_requires_project",
  "direct_fact_priority",
  "direct_goal_priority",
  "direct_source_required",
  "editorial_artifact_version_mismatch",
  "explicit_activation_required",
  "explicit_forget_required",
  "forgotten",
  "future_source",
  "idempotency_conflict",
  "invalid_artifact",
  "invalid_card",
  "invalid_cursor",
  "invalid_cursor_scope",
  "invalid_date",
  "invalid_fact_detail",
  "invalid_fact_type",
  "invalid_input",
  "invalid_key",
  "invalid_limit",
  "invalid_memory_state_payload",
  "invalid_operation",
  "invalid_page_size",
  "invalid_revision",
  "invalid_scope",
  "invalid_source",
  "invalid_work_checkpoint",
  "memory_content_looks_secret",
  "memory_page_changed_retry",
  "memory_record_too_large",
  "memory_result_too_large_select_project",
  "project_missing",
  "project_names_require_direct_source",
  "project_required",
  "project_revision_budget_exceeded",
  "related_project_missing",
  "revision_conflict",
  "scheduled_memory_read_only",
  "scope_limit",
  "source_quote_mismatch",
  "stale_focus_source",
  "stale_source",
  "global_rule_requires_direct_user",
  "work_checkpoint_revision_required",
  "work_acceptance_incomplete",
  "work_requirements_revision_required",
  "work_evidence_revision_required"
]);
/** Game factory codes that mean "the service correctly refused in this state
 * or by its rules" (J11, r1111): the model re-reads, waits or changes its
 * input and adapts on its own. Everything else — *_unavailable, *_failed,
 * *_changed, configuration, limits that need maintenance, integrity
 * mismatches, transport, unknown new codes — stays a technical error.
 * J11-2: memory-tool-rejection.test.ts reads every FactoryError code of the
 * service and the store and requires each one to be in this set or in
 * GAME_FACTORY_TECHNICAL_ERRORS, so a new code forces a decision. */
export const GAME_FACTORY_REJECTIONS: ReadonlySet<string> = new Set([
  "asset_requirements_stale",
  "audio_backend_not_allowed",
  "backend_not_allowed",
  "backend_owner_only",
  "build_not_current",
  "create_not_allowed",
  "create_requires_id_and_zero_revision",
  "current_direct_source_required",
  "execution_not_reconciled",
  "external_execution_unresolved",
  "forgotten_decision_requires_new_explicit_source",
  "human_feedback_source_not_verified",
  "human_review_required",
  "image_task_binding_mismatch",
  "invalid_input",
  "invalid_reference_asset",
  "lease_reconciliation_required",
  "legacy_dispatch_not_allowed",
  "legacy_execution_not_finished",
  "newer_user_input_pending",
  "only_active_project_can_pause",
  "only_paused_project_can_resume",
  "operation_id_conflict",
  "operation_not_authorized",
  "owner_cannot_be_replaced",
  "path_outside_workspace",
  "peer_acceptance_invalid",
  "peer_dispatch_not_allowed",
  "peer_execution_not_finished",
  "peer_goal_too_large",
  "peer_task_already_dispatched",
  "platform_outside_brief",
  "previous_execution_not_confirmed_finished",
  "project_already_terminal",
  "project_and_revision_required",
  "project_content_looks_secret",
  "project_not_active",
  "project_required",
  "receipt_required",
  "reference_only_not_acceptable",
  "release_not_prepared",
  "review_has_unresolved_evidence",
  "revision_conflict",
  "roblox_place_capture_required",
  "roblox_place_entrypoint_required",
  "roblox_place_invalid",
  "roblox_place_missing",
  "roblox_playtest_report_invalid",
  "roblox_playtest_report_mismatch",
  "roblox_two_client_report_required",
  "roblox_requires_studio_verification",
  "submitted_task_requires_build",
  "task_dependencies_not_topological",
  "task_dependencies_pending",
  "task_id_already_used",
  "task_not_available",
  "task_not_submitted",
  "technical_evidence_required",
  "unknown_action",
  "writer_already_claimed",
  "writer_lease_mismatch",
  "writer_must_reconcile_before_replan",
  "writer_owned_by_another_actor",
  "writer_reconciliation_required"
]);
/** Game factory codes decided to stay technical errors (J11-2): the model
 * cannot fix them by itself, someone or something outside has to. */
export const GAME_FACTORY_TECHNICAL_ERRORS: ReadonlySet<string> = new Set([
  "artifact_adapter_unavailable",
  "asset_changed_before_review",
  "asset_unavailable",
  "audio_asset_changed",
  "audio_binding_unavailable",
  "audio_tracks_invalid",
  "backend_adapter_unavailable",
  "base_build_changed",
  "base_build_unavailable",
  "build_limit",
  "build_unavailable",
  "check_receipt_mismatch",
  "check_receipt_too_large",
  "configuration_duplicate_actor",
  "configuration_invalid",
  "configuration_not_private",
  "configuration_paths_must_be_absolute",
  "conflicting_execution_results",
  "database_not_private",
  "database_parent_not_private",
  "database_parent_unavailable",
  "decision_limit",
  "decision_unavailable",
  "factory_actor_disabled",
  "factory_disabled",
  "factory_request_failed",
  "filesystem_preparation_did_not_converge",
  "html5_checker_unavailable",
  "image_adapter_unavailable",
  "image_asset_changed",
  "import_adapter_unavailable",
  "invalid_clock",
  "legacy_adapter_unavailable",
  "legacy_binding_unavailable",
  "legacy_result_changed",
  "member_unavailable",
  "package_manifest_mismatch",
  "packager_unavailable",
  "peer_contract_validator_unavailable",
  "peer_input_build_unavailable",
  "peer_not_configured",
  "peer_operation_unavailable",
  "peer_result_adapter_unavailable",
  "peer_result_changed",
  "platform_manifest_check_failed",
  "project_too_large_archive_builds",
  "project_unavailable",
  "publication_account_unavailable",
  "receipt_unavailable",
  "reference_file_unavailable",
  "reference_limit",
  "release_build_changed",
  "release_unavailable",
  "result_too_large",
  "review_build_changed",
  "review_evidence_unavailable",
  "task_history_limit"
]);
const GAME_FACTORY_TOOLS = new Set(['game_factory_control', 'game_factory_status']);

function textBlocks(item: Record<string, unknown>): string[] {
  const result = item.result as { content?: unknown } | undefined;
  if (!Array.isArray(result?.content)) return [];
  return result.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.length <= 100_000)
    .map(block => block.text as string);
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; } /* unstructured output is not evidence of a policy refusal */
}

export function isMemoryToolRejection(item: Record<string, unknown>): boolean {
  if (item.server !== 'claudeclaw' ||
      (item.tool !== 'memory_state' && item.tool !== 'memory_state_read')) return false;
  return textBlocks(item).some(text => {
    // The pinned MCP SDK returns input-schema errors before the handler,
    // so there is no authenticated IPC result for these rejections.
    if (text.startsWith(`MCP error -32602: Input validation error: Invalid arguments for tool ${item.tool}: `))
      return true;
    const response = parse(text);
    return response?.type === 'memory_state_result' && response.ok === false &&
      typeof response.error === 'string' && MEMORY_REJECTIONS.has(response.error);
  });
}

/** A structured game factory refusal: the host's typed code, never free text. */
function isGameFactoryRejection(item: Record<string, unknown>): boolean {
  if (item.server !== 'claudeclaw' || !GAME_FACTORY_TOOLS.has(String(item.tool))) return false;
  return textBlocks(item).some(text => {
    const response = parse(text);
    return response?.ok === false && typeof response.error === 'string' &&
      GAME_FACTORY_REJECTIONS.has(response.error);
  });
}

/** The live checkpoint held this very call for a newer user message: the tool
 * did not run, nothing failed (user-update-checkpoint.ts). */
function isUserUpdatePause(item: Record<string, unknown>): boolean {
  if (item.server !== 'claudeclaw' || typeof item.tool !== 'string' || !item.tool) return false;
  const texts = textBlocks(item);
  return texts.includes(userUpdatePauseText(item.tool)) &&
    texts.some(text => parse(text)?.kind === 'pending_user_updates');
}

/** A failed own-tool call that is an expected refusal, not a breakdown. The
 * runner files it under toolRejections, not toolErrors. Whether the watchdog
 * still sends a notice is the watchdog's rule (J11-1): with W35 (branch
 * r1111/w2-watchdog) its threshold counts only technical errors and old
 * unclassified rows, rejections are only shown in the text; a watchdog
 * without W35 counts rejections too, and then J11 changes only the wording. */
export function isToolRejection(item: Record<string, unknown>): boolean {
  return isMemoryToolRejection(item) || isGameFactoryRejection(item) || isUserUpdatePause(item);
}
