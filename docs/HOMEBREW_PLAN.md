# Future Homebrew Plan

Potential tap:

```text
OWNER/homebrew-skoobi
```

Potential install command:

```bash
brew install OWNER/skoobi/skoobi
```

## Formula

Formula path:

```text
Formula/skoobi.rb
```

The formula should install from a GitHub release tarball:

```ruby
class Skoobi < Formula
  desc "Telegram-first Skoobi assistant runtime"
  homepage "https://github.com/OWNER/skoobi-agent"
  url "https://github.com/OWNER/skoobi-agent/archive/refs/tags/vX.Y.Z.tar.gz"
  sha256 "..."
  license "..."

  depends_on "node@22"
  depends_on "sqlite"
  depends_on "git"

  def install
    system "npm", "ci"
    system "npm", "run", "build"
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/skoobi.js" => "skoobi"
  end
end
```

## Services

Homebrew could either:

1. Delegate to `scripts/install.sh`, which creates `com.skoobi.default`; or
2. Use `brew services` with a Homebrew-managed plist.

Because Skoobi keeps user state under `~/.skoobi/instances/default`, the
formula must not put `.env`, `groups`, `store`, or logs under the Homebrew Cellar.

## Required Release Work

- Publish versioned GitHub release tarballs.
- Compute and update `sha256`.
- Decide license metadata.
- Add formula CI with `brew test-bot`.
- Verify service install/update/uninstall behavior.

## Not Done Now

No Homebrew tap or formula is created in this phase.
