# Release Process

Skoobi Agent releases are created from Git tags that match `package.json` version. The release workflow runs CI, attaches `scripts/install.sh`, and attaches a SHA-256 checksum file.

The release workflow does not publish npm, create a Homebrew tap, or touch any runtime instance.

## Create A Release Tag

1. Make sure `package.json` has the version you want to release.

2. Run local checks:

   Use Node.js 22. If you use `nvm`:

   ```bash
   nvm use 22
   ```

   ```bash
   npm test
   npm run typecheck
   npm run build
   cd agent/runner && npm run build
   cd ../..
   bash -n scripts/*.sh
   node bin/skoobi.js --help
   ```

   On macOS with Homebrew Node 22, you can run:

   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   ```

3. Create and push a matching public tag:

   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   git tag -a "v$VERSION" -m "Skoobi Agent v$VERSION"
   git push origin "v$VERSION"
   ```

The GitHub Actions release workflow runs only for tags shaped like `vX.Y.Z`. It also verifies that the tag equals `v${package.json.version}`.

## Verify Release Assets

After the workflow finishes, check the release:

```bash
gh release view "v$(node -p "require('./package.json').version")" \
  --repo barmashovdmitrii-droid/skoobi-agent
```

Download and verify `install.sh`:

```bash
VERSION="$(node -p "require('./package.json').version")"
mkdir -p /tmp/skoobi-release-check
cd /tmp/skoobi-release-check

gh release download "v$VERSION" \
  --repo barmashovdmitrii-droid/skoobi-agent \
  --pattern 'install.sh*'

shasum -a 256 -c install.sh.sha256
bash -n install.sh
./install.sh --version
```

## Install From Latest Release

Review the installer before piping it to `bash`.

```bash
curl -fsSL https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/latest/download/install.sh | bash
```

## Release Installer Smoke

Use a temporary prefix. Do not test releases against a real production instance.

```bash
VERSION="$(node -p "require('./package.json').version")"
rm -rf /tmp/skoobi-agent-release-smoke
mkdir -p /tmp/skoobi-agent-release-smoke/home

HOME=/tmp/skoobi-agent-release-smoke/home \
bash /tmp/skoobi-release-check/install.sh \
  --prefix /tmp/skoobi-agent-release-smoke \
  --instance smoke \
  --ref "v$VERSION" \
  --no-service \
  --no-start \
  --yes
```

Verify:

```bash
test -d /tmp/skoobi-agent-release-smoke/app/skoobi-agent
test -f /tmp/skoobi-agent-release-smoke/instances/smoke/.env
grep '^SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=' /tmp/skoobi-agent-release-smoke/instances/smoke/.env
/tmp/skoobi-agent-release-smoke/app/skoobi-agent/bin/skoobi.js paths \
  --prefix /tmp/skoobi-agent-release-smoke \
  --instance smoke
```

Expected:

```text
SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED="false"
```

## Roll Back A Release

If a release is bad, do not rewrite user data. Roll back by removing the bad GitHub Release and tag, then use the previous release.

Delete the bad release and remote tag:

```bash
BAD_VERSION="vX.Y.Z"
gh release delete "$BAD_VERSION" \
  --repo barmashovdmitrii-droid/skoobi-agent \
  --cleanup-tag \
  --yes
```

Delete the local tag if it exists:

```bash
git tag -d "$BAD_VERSION" || true
```

Verify that `latest` points back to the previous good release:

```bash
gh release view --repo barmashovdmitrii-droid/skoobi-agent
```

For an installed instance, update or reinstall from the previous good tag:

```bash
~/.skoobi/app/skoobi-agent/scripts/update.sh --ref vPREVIOUS.GOOD.VERSION
```

Runtime rollback is deployment-specific and separate from release rollback. Preserve instance `.env`, `groups/`, `store/`, `logs/`, and audit/accounting data.
