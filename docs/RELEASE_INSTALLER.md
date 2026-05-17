# Release Installer Plan

This is a plan only. Do not create a GitHub release, publish npm, or create a
Homebrew tap from this document alone.

## Why Release Assets Beat `main`

The current one-line installer uses `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/skoobi-agent/main/scripts/install.sh | bash
```

That is convenient during private development, but it is not ideal for a stable
installer because `main` can move at any time. A release asset is better because
it can be tied to a tag, changelog, checksum, and tested build.

Future release command:

```bash
curl -fsSL https://github.com/OWNER/skoobi-agent/releases/latest/download/install.sh | bash
```

Users should still review `install.sh` before piping it to `bash`.

## Checksum And Signing Plan

For each release:

- Attach `install.sh` as a release asset.
- Attach `checksums.txt` with SHA-256 checksums for installer assets.
- Publish the expected checksum in release notes.
- Add a future optional installer flag to verify checksum before continuing.
- Consider signing release assets with `cosign` or GPG once the release process
  is stable.

The installer must continue to avoid printing secrets and must not read Codex,
Claude, browser, or OAuth credential files.

## Future npm `create-skoobi`

Planned command:

```bash
npm exec --yes create-skoobi@latest
```

The future package should be a small wrapper that:

- Downloads a pinned GitHub release installer.
- Verifies checksum when available.
- Runs the same install flow and flags as `scripts/install.sh`.
- Never embeds Telegram, Codex, Claude, or OpenAI credentials.

No npm package is published yet.

## Future Homebrew

Planned command:

```bash
brew install OWNER/skoobi/skoobi
```

The future tap can live in a repository such as
`OWNER/homebrew-skoobi` and include
`Formula/skoobi.rb`. The formula should install from a tagged GitHub release
tarball with a pinned SHA-256 checksum.

Homebrew service integration can be considered later, but the current installer
already supports launchd and user systemd services.

No Homebrew tap is created yet.
