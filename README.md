# xDIST (Did I Ship Today?)

An htop-style CLI dashboard for tracking AI usage, limits, and costs across multiple providers.

## Installation

```bash
bun install -g xdist
```

## Usage

Simply run:

```bash
xdist
```

Or run without installing:

```bash
bunx xdist
```

- **Chernobyl Heatmap**: Character-by-character scan animation for revealing historical data.
- **Provider Tracking**: Support for GitHub Copilot, Anthropic, OpenAI, and more.
- **Quota & Cost**: Track both usage limits (requests) and cost caps (USD).
- **Theme Support**: Unified "success" (scanline) aesthetics.
- **Auto-Config**: Prompt-based credential setup for new providers.
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
