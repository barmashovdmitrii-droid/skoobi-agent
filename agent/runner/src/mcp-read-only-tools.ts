/**
 * claudeclaw MCP tools that only read (W15).
 *
 * Codex 0.166 asks approval for every MCP tool call whose tool carries no
 * annotations. A turn that carries forwarded text runs with
 * `--sandbox read-only` and approval_policy never, so even memory_search and
 * memory_get were refused there («MCP tool call requires approval, but
 * approval policy is never»: every call that was checked), although
 * the read-only profile keeps exactly these tools on purpose
 * (task-scheduler READ_ONLY_TASK_DISALLOWED_TOOLS). `readOnlyHint: true`
 * lets Codex run them without approval; verified offline on codex 0.166.0
 * against a local mock model: a hinted tool ran, an unhinted one was refused.
 *
 * Nothing that sends, saves, schedules or drives the Mac or Codex Desktop is
 * listed here: those still need approval and stay refused in that mode.
 */
export const READ_ONLY_CLAUDECLAW_TOOLS: ReadonlySet<string> = new Set([
  'memory_search',
  'memory_get',
  'memory_state_read',
  'chat_history',
  'list_tasks',
  'skill_list',
  'skill_view',
  'delivery_status',
  'check_user_updates',
  'codex_quota_status',
  'wait_until',
]);

export const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
});

/**
 * server.tool(name, description, schema, handler) for a listed tool becomes
 * server.tool(name, description, schema, annotations, handler); any other
 * call is returned unchanged.
 */
export function withReadOnlyToolHint(args: unknown[]): unknown[] {
  const name = args[0];
  if (typeof name !== 'string' || !READ_ONLY_CLAUDECLAW_TOOLS.has(name)) {
    return args;
  }
  if (
    args.length !== 4 ||
    typeof args[1] !== 'string' ||
    typeof args[2] !== 'object' ||
    args[2] === null ||
    typeof args[3] !== 'function'
  ) {
    return args;
  }
  return [
    args[0],
    args[1],
    args[2],
    { ...READ_ONLY_TOOL_ANNOTATIONS },
    args[3],
  ];
}
