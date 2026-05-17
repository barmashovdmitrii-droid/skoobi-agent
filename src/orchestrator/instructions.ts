import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
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

export function findTenantInstructions(groupDir: string): string | null {
  for (const filename of TENANT_INSTRUCTION_FILENAMES) {
    const candidate = path.join(groupDir, filename);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* absent or unreadable candidates are simply skipped */
    }
  }
  return null;
}

export function loadTenantInstructions(
  groupDir: string,
): TenantInstructions | null {
  const filePath = findTenantInstructions(groupDir);
  if (!filePath) return null;

  const filename = path.basename(filePath) as TenantInstructionFilename;
  const content = fs.readFileSync(filePath, 'utf8');
  return { filePath, filename, content };
}

function shouldInjectIntoAgentConfig(instructions: TenantInstructions): boolean {
  // The Claude Agent SDK already loads CLAUDE.md from cwd. Inject only the new
  // compatibility names so legacy CLAUDE.md behaviour stays unchanged.
  return instructions.filename !== 'CLAUDE.md';
}

export function agentConfigWithTenantInstructions(
  group: RegisteredGroup,
): AgentConfig | undefined {
  let instructions: TenantInstructions | null = null;
  try {
    instructions = loadTenantInstructions(resolveGroupFolderPath(group.folder));
  } catch {
    return group.agentConfig;
  }

  if (!instructions || !shouldInjectIntoAgentConfig(instructions)) {
    return group.agentConfig;
  }

  const tenantBlock = `<tenant_instructions source="${instructions.filename}">
${instructions.content}
</tenant_instructions>`;
  const existingPrompt = group.agentConfig?.systemPrompt?.trim();

  return {
    ...(group.agentConfig || {}),
    systemPrompt: existingPrompt
      ? `${tenantBlock}\n\n${existingPrompt}`
      : tenantBlock,
  };
}
