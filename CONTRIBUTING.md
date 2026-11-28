# Contributing

Thank you for helping improve Skoobi Agent.

## Before opening a pull request

1. Do not use production data in code, tests, screenshots, or logs.
2. Use neutral IDs and paths in fixtures.
3. Add regression tests for behavior and security-boundary changes.
4. Run:

   ```bash
   npm ci
   npm test
   npm run typecheck
   npm run build
   ```

5. Review the complete diff for credentials, personal data, absolute local
   paths, generated files, and unrelated changes.

Security reports belong in a private GitHub security advisory, not a public
issue.
