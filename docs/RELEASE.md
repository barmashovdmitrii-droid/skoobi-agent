# Public release process

Public releases are built from a clean, allowlisted export. The private
deployment repository and its history are never mirrored to the public
repository.

Before a release:

1. Pin the exact reviewed source commit.
2. Generate the export into a new empty directory.
3. Keep the generated provenance manifest beside the export as private release
   evidence; do not copy it into the public repository.
4. Scan the export for secrets, personal data, local paths, unsafe file types,
   and unexpected files.
5. From a fresh clone run `npm ci`, the complete tests, typecheck, build, and
   the agent-runner build.
6. Review the entire public diff.
7. Merge through a protected branch with passing CI.
8. Create tags and release assets only from the public repository.

The release job must embed the peeled `GITHUB_SHA` commit and the explicit tag
ref into the checksum-protected installer asset. A release installer must fail
if that tag is moved or resolves to any other commit. Before building assets,
the workflow freshly fetches the exact public `origin/main` ref and fails
closed unless the tagged commit is reachable from it. Tests and builds run in a
read-only verification job. A separate fresh publishing job runs no dependency
install or build and reads the installer, package metadata, and release helper
directly from the exact commit with `git show`.

Never use a mirror push, copy private tags, or convert the deployment
repository to public.

If an existing public repository contains files or identifiers that the new
export policy forbids, adding a clean commit is insufficient because the old
refs remain readable. Treat that as a separate, owner-approved remediation:
inventory every branch and tag, retain a private recovery bundle, publish a
fresh public root, retire stale refs plus old release assets, and enable branch
protection immediately after the cutover. Do not automate or perform that
destructive step as part of the exporter.
