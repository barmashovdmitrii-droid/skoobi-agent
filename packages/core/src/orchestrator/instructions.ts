import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { personaSystemPrompt } from './persona-registry.js';
import { escapeXml } from './router.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';
import { SKOOBI_TRUTHFULNESS_PROMPT } from './truthfulness.js';
import type { AgentConfig, RegisteredGroup } from './types.js';

export const TENANT_INSTRUCTION_FILENAMES = [
  'AGENT.md',
  'SKOOBI.md',
  'CLAUDE.md',
] as const;

export type TenantInstructionFilename =
  (typeof TENANT_INSTRUCTION_FILENAMES)[number];

export interface TenantInstructions {
  filePath: string;
  filename: TenantInstructionFilename;
  content: string;
}

function pathIsWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (Boolean(relative) &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative))
  );
}

/**
 * Locate a tenant instruction file (AGENT.md/SKOOBI.md/CLAUDE.md) inside a group
 * directory, refusing anything that escapes it.
 *
 * SECURITY: the group directory is bind-mounted read-write into an UNTRUSTED
 * guest sandbox, so a guest can plant a symlink (`ln -s /…/.env AGENT.md`)
 * pointing at host secrets, another tenant's DB, a payment client certificate, or
 * ~/.codex/auth.json. loadTenantInstructions runs in the trusted HOST process and
 * its result is spliced into the agent's system prompt (agentConfigWithTenantInstructions),
 * so blindly statSync/readFileSync-ing a symlinked candidate would read those host
 * secrets straight into a guest-visible prompt. We therefore (1) resolve the group
 * root to its real path, (2) reject any candidate whose final component is a symlink
 * (lstat, not stat), and (3) require the resolved real path to stay within the group
 * root.
 *
 * IMPORTANT: the returned pathname is discovery information, not a durable
 * security capability: any pathname can be replaced after this function
 * returns. Security-sensitive consumers must use loadTenantInstructions(),
 * which opens with O_NOFOLLOW and reads from that same descriptor.
 */
export function findTenantInstructions(groupDir: string): string | null {
  let groupRoot: string;
  try {
    groupRoot = fs.realpathSync(path.resolve(groupDir));
  } catch {
    return null;
  }
  for (const filename of TENANT_INSTRUCTION_FILENAMES) {
    const candidate = path.join(groupRoot, filename);
    try {
      // lstat (not stat) so a symlink is NOT mistaken for a regular file.
      const linkStat = fs.lstatSync(candidate);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) continue;
      const real = fs.realpathSync(candidate);
      // Belt-and-suspenders: reject anything resolving outside the group root.
      if (!pathIsWithin(groupRoot, real)) continue;
      return real;
    } catch {
      /* absent or unreadable candidates are simply skipped */
    }
  }
  return null;
}

// A tenant instruction file is guest-writable and its body is XML-escaped
// (≈4× transient) and spliced into the host system prompt on every turn. Reading
// a huge file wholly into the single shared process (a guest could write a 400MB
// AGENT.md) can OOM/GC-thrash it for all tenants, so bound the read to a generous
// prefix — real instruction prose is far smaller (ultra-review 2026-07-11 #8).
const MAX_TENANT_INSTRUCTION_BYTES = 256 * 1024;

export function loadTenantInstructions(
  groupDir: string,
): TenantInstructions | null {
  try {
    const groupRoot = fs.realpathSync(path.resolve(groupDir));
    for (const filename of TENANT_INSTRUCTION_FILENAMES) {
      const filePath = path.join(groupRoot, filename);
      try {
        const { buffer } = readBoundedRegularFileNoFollowSync(filePath, {
          maxBytes: MAX_TENANT_INSTRUCTION_BYTES,
          oversize: 'truncate',
          requireSingleLink: true,
        });
        return { filePath, filename, content: buffer.toString('utf8') };
      } catch {
        // Preserve the documented fallback order when a candidate is absent,
        // unreadable, a symlink, or another non-regular file.
      }
    }
  } catch {
    return null;
  }
  return null;
}

const PROTECTED_PROMPT_MARKER_RE =
  /<\/?\s*(?:skoobi_truthfulness|skoobi_persona|tenant_instructions)\b[^>]*>/gi;

/**
 * Strip ClaudeClaw's protected system-prompt markers from tenant-controlled
 * text. A tenant instruction file (AGENT.md/SKOOBI.md) is untrusted: embedding a
 * literal `<skoobi_truthfulness>` would make agentConfigWithTruthfulness believe
 * the safety prompt is already present and SKIP injecting the real one
 * (suppressing safety), and a stray `</tenant_instructions>` would let tenant
 * text escape its own wrapper. Removing these tags neutralizes both.
 */
export function sanitizeTenantInstructionContent(content: string): string {
  return content.replace(PROTECTED_PROMPT_MARKER_RE, '');
}

function shouldInjectIntoAgentConfig(
  instructions: TenantInstructions,
): boolean {
  // The Claude Agent SDK already loads CLAUDE.md from cwd. Inject only the new
  // compatibility names so legacy CLAUDE.md behaviour stays unchanged.
  return instructions.filename !== 'CLAUDE.md';
}

export function agentConfigWithTenantInstructions(
  group: RegisteredGroup,
  opts: {
    personaId?: string | null;
    /**
     * False for a downgraded guest turn in a multi-sender main chat.  The
     * canonical main instruction file belongs to the owner namespace and must
     * not be disclosed or semantically applied to that isolated guest run.
     */
    includeTenantInstructions?: boolean;
  } = {},
): AgentConfig | undefined {
  if (opts.includeTenantInstructions === false) {
    return agentConfigWithTruthfulness(
      agentConfigWithPersona(group.agentConfig, opts.personaId),
    );
  }
  let instructions: TenantInstructions | null = null;
  try {
    instructions = loadTenantInstructions(resolveGroupFolderPath(group.folder));
  } catch {
    return agentConfigWithTruthfulness(
      agentConfigWithPersona(group.agentConfig, opts.personaId),
    );
  }

  if (!instructions || !shouldInjectIntoAgentConfig(instructions)) {
    return agentConfigWithTruthfulness(
      agentConfigWithPersona(group.agentConfig, opts.personaId),
    );
  }

  // The tenant instruction file is UNTRUSTED (a guest can write AGENT.md/SKOOBI.md
  // into its writable group dir). XML-escape the body before splicing it into the
  // host system prompt so no guest-supplied `<`/`>`/`&` can introduce or close any
  // structural tag (e.g. a forged `<message sender="owner">` or `<system>` block).
  // This matches loadTenantLongTermPromptContext (message-loop.ts) and router.ts.
  // sanitizeTenantInstructionContent is kept as belt-and-suspenders and is applied
  // first; escaping then renders any remaining tag-like text inert.
  const tenantBlock = `<tenant_instructions source="${escapeXml(instructions.filename)}">
${escapeXml(sanitizeTenantInstructionContent(instructions.content))}
</tenant_instructions>`;
  const withPersona = agentConfigWithPersona(group.agentConfig, opts.personaId);
  const existingPrompt = withPersona?.systemPrompt?.trim();

  return agentConfigWithTruthfulness({
    ...(withPersona || {}),
    systemPrompt: existingPrompt
      ? `${tenantBlock}\n\n${existingPrompt}`
      : tenantBlock,
  });
}

function agentConfigWithPersona(
  config: AgentConfig | undefined,
  personaId?: string | null,
): AgentConfig | undefined {
  const resolvedPersonaId = personaId || config?.personaId;
  if (!resolvedPersonaId) return config;
  const personaBlock = personaSystemPrompt(resolvedPersonaId);
  const existingPrompt = config?.systemPrompt?.trim();
  if (existingPrompt?.includes('<skoobi_persona ')) return config;
  return {
    ...(config || {}),
    personaId: resolvedPersonaId,
    systemPrompt: existingPrompt
      ? `${personaBlock}\n\n${existingPrompt}`
      : personaBlock,
  };
}

function agentConfigWithTruthfulness(
  config: AgentConfig | undefined,
): AgentConfig {
  const existingPrompt = config?.systemPrompt?.trim();
  if (existingPrompt?.includes('<skoobi_truthfulness>')) {
    return config || { systemPrompt: SKOOBI_TRUTHFULNESS_PROMPT };
  }
  return {
    ...(config || {}),
    systemPrompt: existingPrompt
      ? `${SKOOBI_TRUTHFULNESS_PROMPT}\n\n${existingPrompt}`
      : SKOOBI_TRUTHFULNESS_PROMPT,
  };
}
