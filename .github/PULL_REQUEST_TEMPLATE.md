## Summary

Describe what changed and why.

## Checks

- [ ] `npm ci`
- [ ] `npm ci --prefix agent/runner`
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `bash -n scripts/*.sh`

## Safety

- [ ] No secrets, personal identifiers, private paths, or production data.
- [ ] No `.env`, `groups/`, `store/`, `data/`, logs, or databases.
- [ ] No Codex, Claude, browser, SSH, or messaging-session credentials.
- [ ] Authority, tenant isolation, and fail-closed behavior remain covered.
- [ ] Installer defaults remain conservative.

## Notes

Redact tokens, user/chat IDs, private messages, and local paths from supporting
material.
