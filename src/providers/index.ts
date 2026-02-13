import { z } from "zod";
import type { AgentConfig, AgentKey, AgentProvider, UsageBreakdownItem, UsageResult } from "../types";

const githubUsageSchema = z.object({
  timePeriod: z
    .object({
      year: z.number().optional(),
      month: z.number().optional(),
      day: z.number().optional(),
    })
    .optional(),
  user: z.string().optional(),
  usageItems: z.array(
    z.object({
      product: z.string(),
      sku: z.string(),
      model: z.string(),
      unitType: z.string(),
      grossQuantity: z.number().optional(),
      grossAmount: z.number().optional(),
      discountQuantity: z.number().optional(),
      discountAmount: z.number().optional(),
      netQuantity: z.number().optional(),
      netAmount: z.number().optional(),
      pricePerUnit: z.number().optional(),
    }),
  ),
});

function valueOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ensureConfigured(value: string | undefined, fieldName: string): string {
  const cleaned = value?.trim();
  if (!cleaned) {
    throw new Error(`Missing ${fieldName}`);
  }

  return cleaned;
}

function makeManualUsage(label: string, cfg: AgentConfig): UsageResult {
  const used = cfg.manualUsed ?? 0;
  const cost = cfg.manualCost ?? 0;
  const limit = cfg.billingMode === "quota" ? cfg.monthlyLimit : undefined;

  const details: string[] = [
    "Manual provider mode (live API integration can be added later).",
    `Agent: ${label}`,
    cfg.billingMode === "payg" ? "Billing mode: pay-as-you-go" : "Billing mode: monthly quota",
  ];

  return {
    used,
    limit,
    unit: "req",
    cost,
    details,
  };
}

async function fetchGitHubCopilotUsage(cfg: AgentConfig): Promise<UsageResult> {
  const token = ensureConfigured(cfg.token, "GitHub token");
  const username = ensureConfigured(cfg.username, "GitHub username");

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const endpoint = new URL(`https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage`);
  endpoint.searchParams.set("year", String(year));
  endpoint.searchParams.set("month", String(month));

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "usage-limits-opentui",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    const detail = body.length > 160 ? `${body.slice(0, 157)}...` : body;
    throw new Error(`GitHub API ${response.status}: ${detail || response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  const parsed = githubUsageSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error("GitHub API returned an unexpected response shape.");
  }

  const byModel = new Map<string, UsageBreakdownItem>();
  let used = 0;
  let cost = 0;
  let discountQuantity = 0;

  for (const item of parsed.data.usageItems) {
    const quantity = valueOrZero(item.grossQuantity) || valueOrZero(item.netQuantity);
    const amount = valueOrZero(item.netAmount) || valueOrZero(item.grossAmount);
    const discount = valueOrZero(item.discountQuantity);

    used += quantity;
    cost += amount;
    discountQuantity += discount;

    const existing = byModel.get(item.model);
    if (existing) {
      existing.used += quantity;
      existing.cost += amount;
    } else {
      byModel.set(item.model, {
        label: item.model,
        used: quantity,
        cost: amount,
      });
    }
  }

  const breakdown = [...byModel.values()].sort((a, b) => b.used - a.used);
  const details: string[] = [
    `GitHub user: ${username}`,
    `Window: ${year}-${String(month).padStart(2, "0")}`,
    `Discounted/Included quantity: ${discountQuantity.toFixed(0)} req`,
    "Endpoint: /users/{username}/settings/billing/premium_request/usage",
  ];

  if (breakdown.length === 0) {
    details.push("No usage rows returned for this period.");
  }

  return {
    used,
    limit: cfg.billingMode === "quota" ? cfg.monthlyLimit : undefined,
    unit: "req",
    cost,
    details,
    breakdown,
  };
}

function keyProvider(
  key: AgentKey,
  label: string,
  accent: string,
  description: string,
  billingMode: "quota" | "payg",
): AgentProvider {
  return {
    key,
    label,
    accent,
    description,
    supportsLiveFetch: false,
    credentialName: "apiKey",
    isConfigured: (cfg) => Boolean(cfg.apiKey?.trim()),
    fetchUsage: async (cfg) => {
      if (!cfg.apiKey?.trim()) {
        throw new Error(`${label} API key is not configured.`);
      }

      return makeManualUsage(label, { ...cfg, billingMode });
    },
  };
}

export const PROVIDERS: AgentProvider[] = [
  {
    key: "github-copilot",
    label: "GitHub Copilot",
    accent: "#58a6ff",
    description: "Live premium request usage via GitHub billing API.",
    supportsLiveFetch: true,
    credentialName: "token",
    isConfigured: (cfg) => Boolean(cfg.token?.trim() && cfg.username?.trim()),
    fetchUsage: fetchGitHubCopilotUsage,
  },
  keyProvider("codex", "Codex", "#00d4ff", "OpenAI/Codex usage (manual until API adapter is added).", "quota"),
  keyProvider("claude", "Claude", "#ff9d4d", "Anthropic Claude usage (manual until API adapter is added).", "quota"),
  keyProvider("zai", "Z.ai", "#8f7cff", "Z.ai usage (manual until API adapter is added).", "quota"),
  keyProvider("minimax", "MiniMax", "#61e294", "MiniMax usage (manual until API adapter is added).", "quota"),
  keyProvider("vercel-ai", "Vercel AI SDK", "#d7d7d7", "PAYG mode: show full bar + cost.", "payg"),
];

export function getProvider(key: AgentKey): AgentProvider {
  const found = PROVIDERS.find((provider) => provider.key === key);
  if (!found) {
    throw new Error(`Unknown provider: ${key}`);
  }

  return found;
}
