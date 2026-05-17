## Summary

Describe what changed and why.

## Checks

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `cd agent/runner && npm run build`
- [ ] `bash -n scripts/*.sh`
- [ ] `node bin/skoobi.js --help`

## Safety

- [ ] No secrets committed.
- [ ] No `.env`, `groups/`, `store/`, `logs/`, or runtime database files committed.
- [ ] No Codex/Claude auth/session files committed.
- [ ] No owner/main rollout changes unless explicitly reviewed.
- [ ] No owner shell/write/restart tooling added.
- [ ] Installer defaults remain conservative for new users.

## Notes

Add screenshots, logs, or migration notes if useful. Redact tokens, user IDs, chat IDs, private messages, and local machine paths.
