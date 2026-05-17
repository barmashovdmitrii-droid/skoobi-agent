# Skoobi Agent Announcement Draft

Skoobi Agent is an open-source Telegram-first personal assistant runtime for people who want a self-hosted AI assistant with memory, quotas, and a safer provider fallback path.

It is useful for builders, small teams, and operators who want to run a Telegram assistant that can start with Codex subscription-based execution and fall back to Claude SDK when the primary provider is unavailable.

Install:

```bash
curl -fsSL https://github.com/barmashovdmitrii-droid/skoobi-agent/releases/latest/download/install.sh | bash
```

Review `install.sh` before piping it to `bash`.

Current limitations:

- Telegram is the primary supported channel.
- New installs keep global guest live mode disabled by default.
- Codex CLI and Claude CLI login are local operator responsibilities.
- npm `create-skoobi` and Homebrew installers are planned but not published yet.
- Production use still requires careful secret handling, backup discipline, and staged rollout.

