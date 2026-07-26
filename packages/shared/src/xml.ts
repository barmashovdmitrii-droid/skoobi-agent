// Generic XML/HTML escaping helper (moved from orchestrator/router.ts,
// modularization wave 2, 2026-07-07).
export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
