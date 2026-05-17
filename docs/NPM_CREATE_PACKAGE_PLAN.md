# Future npm Create Package Plan

Package name:

```text
create-skoobi
```

Future command:

```bash
npm exec --yes create-skoobi@latest
```

## Goal

Provide an npm-native bootstrapper that installs Skoobi without requiring users
to pipe shell from GitHub.

## Proposed Structure

```text
packages/create-skoobi/
  package.json
  bin/create-skoobi.js
  README.md
```

## Behavior

The package should:

1. Ask for install prefix and instance name.
2. Download a GitHub release tarball or clone the repository.
3. Reuse the same installer logic as `scripts/install.sh`.
4. Create app and instance directories.
5. Generate launchd/systemd service files.
6. Keep secrets only in instance `.env`.
7. Default `SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=false`.

## Security Rules

- Do not read Codex auth files.
- Do not read Claude auth/session files.
- Do not read browser cookies.
- Do not print Telegram/OpenAI/provider tokens.
- Do not store secrets in npm package config.

## Release Flow

1. Create a GitHub release for `skoobi-agent`.
2. Publish `create-skoobi` with a pinned release URL and checksum.
3. Add smoke tests on macOS and Linux.
4. Document rollback and uninstall.

## Not Done Now

No npm package is created or published in this phase.
