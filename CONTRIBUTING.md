# Contributing

Thanks for helping improve Skoobi Agent.

## Requirements

- Node.js 22+
- npm
- git
- sqlite3 for local database-related tests

## Local Checks

Use Node.js 22. If you use `nvm`:

```bash
nvm use 22
```

Run these before opening a pull request:

```bash
npm test
npm run typecheck
npm run build
cd agent/runner && npm run build
cd ..
bash -n scripts/*.sh
node bin/skoobi.js --help
```

On macOS with Homebrew Node 22, you can run:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

## Pull Requests

1. Open a focused PR with a clear description of the change.
2. Include the checks you ran and their results.
3. Add or update tests when behavior changes.
4. Keep runtime behavior changes small and explicit.
5. Do not mix documentation cleanup with risky runtime changes unless the PR explains why.

## Secrets And Runtime Data

Never commit:

- `.env` or `.env.*`
- Telegram bot tokens
- OpenAI, Anthropic, GitHub, Slack, or other API keys
- Codex or Claude auth/session files
- browser cookies or localStorage/sessionStorage
- SSH private keys
- `groups/`
- `store/`
- `logs/`
- runtime databases such as `messages.db`

Use `.env.example` for placeholders and safe defaults only.

## Safety Notes

- Do not enable owner/main rollout casually.
- Do not add owner shell/write/restart tools without a separate security review.
- Do not make model output a permission boundary.
- Preserve tenant isolation and audit/accounting data.
- Keep install defaults conservative: new installs should not enable global live behavior automatically.
