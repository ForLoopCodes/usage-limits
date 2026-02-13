import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentConfig, AgentKey, AppConfig, BarStyle, BillingMode } from "./types";

const AGENT_KEYS: AgentKey[] = [
  "github-copilot",
  "codex",
  "claude",
  "zai",
  "minimax",
  "vercel-ai",
  "ollama",
  "openrouter",
  "cursor",
  "antigravity",
  "opencode",
];

const agentConfigSchema = z.object({
  enabled: z.boolean(),
  billingMode: z.enum(["quota", "payg"]),
  accentColor: z.string().optional(),
  token: z.string().optional(),
  apiKey: z.string().optional(),
  username: z.string().optional(),
  monthlyLimit: z.number().positive().optional(),
  costLimit: z.number().positive().optional(),
  manualUsed: z.number().nonnegative().optional(),
  manualCost: z.number().nonnegative().optional(),
});

const barStyleSchema = z.enum(["solid", "shaded", "ascii", "dots", "pipe", "braille"]);

const appConfigSchema = z.object({
  theme: z.string().min(1),
  refreshSeconds: z.number().int().min(1).max(86400),
  barStyle: barStyleSchema,
  dashboardMetrics: z.enum(["req", "cost", "both"]).optional(),
  showModeColumn: z.boolean().optional(),
  heatmapScope: z.enum(["focused", "provider", "total"]).optional(),
  heatmapProvider: z.enum([
    "github-copilot",
    "codex",
    "claude",
    "zai",
    "minimax",
    "vercel-ai",
    "ollama",
    "openrouter",
    "cursor",
    "antigravity",
    "opencode",
  ]).optional(),
  heatmapMetric: z.enum(["req", "cost"]).optional(),
  heatmapChars: z.string().optional(),
  heatmapCellWidth: z.number().int().min(1).max(4).optional(),
  heatmapInfoMode: z.enum(["none", "days", "week", "year", "all"]).optional(),
  heatmapPaletteSteps: z.number().int().min(2).max(9).optional(),
  heatmapMaxDays: z.number().int().min(7).max(364).optional(),
  decimalPlaces: z.number().int().min(0).max(4).optional(),
  selectedAgent: z.enum([
    "github-copilot",
    "codex",
    "claude",
    "zai",
    "minimax",
    "vercel-ai",
    "ollama",
    "openrouter",
    "cursor",
    "antigravity",
    "opencode",
  ]),
  agents: z.object({
    "github-copilot": agentConfigSchema,
    codex: agentConfigSchema,
    claude: agentConfigSchema,
    zai: agentConfigSchema,
    minimax: agentConfigSchema,
    "vercel-ai": agentConfigSchema,
    ollama: agentConfigSchema,
    openrouter: agentConfigSchema,
    cursor: agentConfigSchema,
    antigravity: agentConfigSchema,
    opencode: agentConfigSchema,
  }),
  detailPaneMode: z.enum(["sidebar", "bottom", "hidden"]).optional(),
});

const CONFIG_FILE = ".usage-limits.config.json";

function defaultAgentConfig(mode: BillingMode, enabled: boolean): AgentConfig {
  return {
    enabled,
    billingMode: mode,
    monthlyLimit: mode === "quota" ? 500 : undefined,
    costLimit: mode === "quota" ? 20 : undefined,
    manualUsed: 0,
    manualCost: 0,
  };
}

export function defaultConfig(): AppConfig {
  const defaultBarStyle: BarStyle = "solid";

  return {
    theme: "neon-night",
    refreshSeconds: 60,
    barStyle: defaultBarStyle,
    dashboardMetrics: "both",
    showModeColumn: true,
    heatmapScope: "focused",
    heatmapProvider: "github-copilot",
    heatmapMetric: "req",
    heatmapChars: "⣿",
    heatmapCellWidth: 1,
    heatmapInfoMode: "days",
    heatmapPaletteSteps: 7,
    heatmapMaxDays: 364,
    decimalPlaces: 0,
    selectedAgent: "github-copilot",
    detailPaneMode: "sidebar",
    agents: {
      "github-copilot": { ...defaultAgentConfig("quota", true), monthlyLimit: 500 },
      codex: defaultAgentConfig("quota", false),
      claude: defaultAgentConfig("quota", false),
      zai: defaultAgentConfig("quota", false),
      minimax: defaultAgentConfig("quota", false),
      "vercel-ai": defaultAgentConfig("payg", false),
      ollama: defaultAgentConfig("payg", false),
      openrouter: defaultAgentConfig("payg", false),
      cursor: defaultAgentConfig("payg", false),
      antigravity: defaultAgentConfig("payg", false),
      opencode: defaultAgentConfig("payg", false),
    },
  };
}

export function getConfigPath(): string {
  return join(process.cwd(), CONFIG_FILE);
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function applyEnvironmentOverrides(config: AppConfig): AppConfig {
  const next = structuredClone(config);

  next.agents["github-copilot"].token ??= trimOrUndefined(Bun.env.GITHUB_TOKEN);
  const githubUsername = trimOrUndefined(Bun.env.GITHUB_USERNAME);
  const githubOrg = trimOrUndefined(Bun.env.GITHUB_ORG);
  next.agents["github-copilot"].username ??= githubUsername ?? (githubOrg ? `org:${githubOrg}` : undefined);

  next.agents.codex.apiKey ??= trimOrUndefined(Bun.env.OPENAI_API_KEY);
  next.agents.claude.apiKey ??= trimOrUndefined(Bun.env.ANTHROPIC_API_KEY);
  next.agents.zai.apiKey ??= trimOrUndefined(Bun.env.ZAI_API_KEY);
  next.agents.minimax.apiKey ??= trimOrUndefined(Bun.env.MINIMAX_API_KEY);
  next.agents["vercel-ai"].apiKey ??= trimOrUndefined(Bun.env.VERCEL_AI_GATEWAY_API_KEY);
  next.agents.ollama.apiKey ??= trimOrUndefined(Bun.env.OLLAMA_API_KEY);
  next.agents.openrouter.apiKey ??= trimOrUndefined(Bun.env.OPENROUTER_API_KEY);
  next.agents.cursor.apiKey ??= trimOrUndefined(Bun.env.CURSOR_API_KEY);
  next.agents.antigravity.apiKey ??= trimOrUndefined(Bun.env.ANTIGRAVITY_API_KEY);
  next.agents.opencode.apiKey ??= trimOrUndefined(Bun.env.OPENCODE_API_KEY);

  return next;
}

function ensureAllAgents(config: AppConfig): AppConfig {
  const next = structuredClone(config);

  for (const key of AGENT_KEYS) {
    if (!next.agents[key]) {
      next.agents[key] = defaultAgentConfig("quota", false);
    }
  }

  return next;
}

export function loadConfig(): AppConfig {
  const path = getConfigPath();

  if (!existsSync(path)) {
    const fresh = applyEnvironmentOverrides(defaultConfig());
    saveConfig(fresh);
    return fresh;
  }

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const merged: AppConfig = {
      ...defaultConfig(),
      ...parsed,
      agents: {
        ...defaultConfig().agents,
        ...(parsed.agents ?? {}),
      },
    };
    const validated = appConfigSchema.parse(merged);
    return applyEnvironmentOverrides(ensureAllAgents(validated));
  } catch {
    const fallback = applyEnvironmentOverrides(defaultConfig());
    saveConfig(fallback);
    return fallback;
  }
}

export function saveConfig(config: AppConfig): void {
  const validated = appConfigSchema.parse(config);
  writeFileSync(getConfigPath(), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}
