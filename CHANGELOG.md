# Changelog

All notable public changes to Skoobi Agent are documented here.

## 2.0.0-rc.1

- Reorganized the runtime into workspace packages.
- Added optional WhatsApp, dashboard, Google Workspace, and Desktop bridge
  components behind explicit configuration and authority checks.
- Expanded runtime isolation, tenant protection, safe file handling, and
  regression coverage.
- Kept runtime data, credentials, private operations, and private Git history
  outside the public source export.

Historical note: `2.0.0-rc.1` starts a clean public-source history. Earlier
`1.2.x` tags came from a different publication process and are retired as part
of the privacy-hardening cutover.
