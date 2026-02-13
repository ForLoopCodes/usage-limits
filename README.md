# usage-limits (OpenTUI)

An htop-style CLI dashboard for tracking AI agent usage limits and costs.

Built with:

- Bun + TypeScript
- OpenTUI (`@opentui/core`)

## Features

- htop-like terminal UI with colored progress bars
- Multi-agent structure (GitHub Copilot, Codex, Claude, Z.ai, MiniMax, Vercel AI)
- Theme switching
- Settings page with per-agent enable toggles
- Prompt-based credential setup when an enabled provider is not configured
- Live GitHub premium request billing usage via:
  - `GET /users/{username}/settings/billing/premium_request/usage?year=YYYY&month=MM`
  - `GET /organizations/{org}/settings/billing/premium_request/usage?year=YYYY&month=MM` (set identity as `org:YOUR_ORG`)
- Pay-as-you-go mode support (full bar + cost display)

## Quick start

1. Install dependencies
   - `bun install`
2. Fill `.env` (optional but recommended)
   - `GITHUB_TOKEN`
   - `GITHUB_USERNAME` (preferred)
   - `GITHUB_ORG` (optional; auto-used as `org:...` fallback)
3. Run app
   - `bun run start`

The app will also create `.usage-limits.config.json` in your project folder for local settings and stored credentials.

## Keyboard shortcuts

Global:

- `q` or `Ctrl+C` quit
- `r` refresh usage
- `t` cycle theme
- `s` go to settings
- `d` go to dashboard
- `tab` toggle dashboard/settings

Dashboard:

- `↑/↓` or `j/k` move selection
- `enter` configure selected provider

Settings:

- `↑/↓` or `j/k` move selection
- `space` enable/disable provider
- `e` or `enter` set credentials
- `b` toggle billing mode (`quota` / `payg`)
- `m` set monthly limit
- `u` set manual used value
- `c` set manual cost

## GitHub token notes

For billing usage reports:

- User endpoint typically needs **Plan (read)**.
- Organization endpoint typically needs **Administration (read)** on the organization.
- You can use:
  - Fine-grained PAT
  - GitHub App user access token

This app queries the monthly premium-request endpoint across the last 24 months, keeps model-level breakdown for the current month, and builds the graph from monthly trend points.

## Extending providers

Provider adapters live in `src/providers/index.ts`.

To add a new provider:

1. Add a provider definition to `PROVIDERS`
2. Implement `isConfigured` and `fetchUsage`
3. Add any provider-specific config fields if needed
