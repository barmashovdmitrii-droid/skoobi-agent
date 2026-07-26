import { readEnvFile } from '@skoobi/shared/env';

const DEFAULT_MAIN_SERVICE_LABEL = 'com.skoobi.default';
const DASHBOARD_SERVICE_LABEL = 'com.skoobi.dashboard';
const MAIN_SERVICE_LABEL_PATTERN = /^com\.skoobi\.[A-Za-z0-9_-]{1,63}$/u;

export function validateMainServiceLabel(
  configured: string | undefined,
): string {
  const candidate = configured?.trim() || DEFAULT_MAIN_SERVICE_LABEL;
  if (
    !MAIN_SERVICE_LABEL_PATTERN.test(candidate) ||
    candidate.toLowerCase() === DASHBOARD_SERVICE_LABEL
  ) {
    throw new Error('Invalid SKOOBI_SERVICE_LABEL');
  }
  return candidate;
}

export function resolveMainServiceLabel(): string {
  const fileEnv = readEnvFile(['SKOOBI_SERVICE_LABEL']);
  return validateMainServiceLabel(
    process.env.SKOOBI_SERVICE_LABEL ?? fileEnv.SKOOBI_SERVICE_LABEL,
  );
}
