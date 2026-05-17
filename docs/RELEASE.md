# Release Process

Skoobi Agent releases are created from Git tags that match `package.json` version.
The release workflow runs CI, attaches `scripts/install.sh`, and attaches a
SHA-256 checksum file. It does not publish npm, create a Homebrew tap, or touch
any production runtime instance.

## Create A Release Tag

1. Make sure `package.json` has the version you want to release.

2. Run the local checks:

   ```bash
   PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test
   PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run typecheck
   PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build
   cd agent/runner && PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build
   bash -n scripts/*.sh
   ```

3. Create and push a matching tag:

   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   git tag -a "v$VERSION" -m "Skoobi v$VERSION"
   git push skoobi-private "v$VERSION"
   ```

The GitHub Actions release workflow runs only for tags shaped like `vX.Y.Z`.
It also verifies that the tag equals `v${package.json.version}`.

## Verify Release Assets

After the workflow finishes, check the release:

```bash
gh release view "v$(node -p "require('./package.json').version")" \
  --repo OWNER/skoobi-agent
```

Download and verify `install.sh`:

```bash
VERSION="$(node -p "require('./package.json').version")"
mkdir -p /tmp/skoobi-release-check
cd /tmp/skoobi-release-check

gh release download "v$VERSION" \
  --repo OWNER/skoobi-agent \
  --pattern 'install.sh*'

shasum -a 256 -c install.sh.sha256
bash -n install.sh
./install.sh --version
```

## Install From Latest Release

Review the installer before piping it to `bash`.

```bash
curl -fsSL https://github.com/OWNER/skoobi-agent/releases/latest/download/install.sh | bash
```

For a private repository, use authenticated GitHub CLI download:

```bash
mkdir -p /tmp/skoobi-release-install
cd /tmp/skoobi-release-install

gh release download \
  --repo OWNER/skoobi-agent \
  --pattern install.sh

bash install.sh \
  --repo git@github.com:OWNER/skoobi-agent.git
```

If your SSH config uses a host alias, pass that clone URL instead:

```bash
--repo git@github.com:OWNER/skoobi-agent.git
```

## Roll Back A Release

If a release is bad, do not rewrite production data. Roll back by removing the
bad GitHub Release and tag, then use the previous release.

Delete the bad release and remote tag:

```bash
BAD_VERSION="vX.Y.Z"
gh release delete "$BAD_VERSION" \
  --repo OWNER/skoobi-agent \
  --cleanup-tag \
  --yes
```

Delete the local tag if it exists:

```bash
git tag -d "$BAD_VERSION" || true
```

Verify that `latest` points back to the previous good release:

```bash
gh release view --repo OWNER/skoobi-agent
```

For an installed instance, update or reinstall from the previous good tag:

```bash
~/.skoobi/app/skoobi-agent/scripts/update.sh --ref vPREVIOUS.GOOD.VERSION
```

Emergency runtime rollback remains separate from release rollback:

```bash
scripts/skoobi-global-guest-live-rollback.sh
```
