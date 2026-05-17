# Public Repo Readiness Report

Status: PASS

## Release Status

- Public repo: `barmashovdmitrii-droid/skoobi-agent`
- Current release: `v1.2.14`
- Release workflow: SUCCESS
- Release assets: `install.sh`, `install.sh.sha256`
- Release asset checksum: PASS
- Installer smoke via public HTTPS repository: PASS
- npm published: NO
- Homebrew tap created: NO

## What Changed

- Updated `README.md` for public users:
  - renamed the install section to `Install`
  - kept the release installer command
  - added a warning to review `install.sh` before piping to `bash`
  - added requirements
  - added quick start after install
  - added security model
  - added current limitations
- Confirmed `LICENSE` exists and retained the upstream MIT license attribution.
- Added `CONTRIBUTING.md`.
- Added GitHub issue templates:
  - `.github/ISSUE_TEMPLATE/bug_report.yml`
  - `.github/ISSUE_TEMPLATE/feature_request.yml`
- Added `.github/PULL_REQUEST_TEMPLATE.md`.
- Updated `docs/INSTALL.md` so public release install is the primary path.
- Updated `docs/RELEASE.md` for the public repo release flow.
- Updated `SECURITY.md` wording for the public repository.

## Tests

Checks run for this readiness pass:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `cd agent/runner && npm run build`
- `bash -n scripts/*.sh`
- `node bin/skoobi.js --help`

Result: PASS

## Sensitive Scan

Sensitive scan result: PASS

The scan checked for private tenant IDs, local operator paths, token-like env assignments, private canary labels, private names from the original readiness audit, and old private deployment labels.

Result: 0 hits

## Remaining Limitations

- npm installer is planned but not published.
- Homebrew tap is planned but not created.
- The release installer builds from source locally.
- Codex subscription runtime requires local `codex` CLI login.
- Claude fallback requires local Claude SDK/CLI setup.
- Telegram is the primary supported channel.
- Some legacy ClaudeClaw naming remains in internal extension/tool identifiers for compatibility.
- Root `npm audit` may report a moderate advisory that should be reviewed separately.
- GitHub Actions may show a Node.js 20 action runtime deprecation annotation for current marketplace actions; this is a follow-up before the deprecation deadline.
