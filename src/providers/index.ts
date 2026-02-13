import { z } from "zod";
import type { AgentConfig, AgentKey, AgentProvider, DailyUsagePoint, UsageBreakdownItem, UsageResult } from "../types";

const githubUsageItemSchema = z.object({
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
});

const githubUsageBucketSchema = z.object({
  timePeriod: z
    .object({
      year: z.number().optional(),
      month: z.number().optional(),
      day: z.number().optional(),
    })
    .optional(),
  user: z.string().optional(),
  organization: z.string().optional(),
  usageItems: z.array(githubUsageItemSchema).optional(),
  usage_items: z.array(githubUsageItemSchema).optional(),
});

const githubUsageSchema = z.union([githubUsageBucketSchema, z.array(githubUsageBucketSchema)]);

const githubBillingUsageItemSchema = z.object({
  date: z.string().optional(),
  product: z.string(),
  sku: z.string().optional(),
  quantity: z.number().optional(),
  unitType: z.string().optional(),
  grossAmount: z.number().optional(),
  discountAmount: z.number().optional(),
  netAmount: z.number().optional(),
  repositoryName: z.string().optional(),
});

const githubBillingUsageSchema = z.object({
  usageItems: z.array(githubBillingUsageItemSchema).optional(),
  usage_items: z.array(githubBillingUsageItemSchema).optional(),
});

type JsonRecord = Record<string, unknown>;

function ensureConfigured(value: string | undefined, fieldName: string): string {
  const cleaned = value?.trim();
  if (!cleaned) {
    throw new Error(`Missing ${fieldName}`);
  }

  return cleaned;
}

function valueOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dayKeyFromTimePeriod(period: { year?: number; month?: number; day?: number } | undefined): string | undefined {
  const y = period?.year;
  const m = period?.month;
  const d = period?.day;

  if (typeof y === "number" && typeof m === "number" && typeof d === "number") {
    return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
  }

  if (typeof y === "number" && typeof m === "number") {
    return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`;
  }

  if (typeof y === "number") {
    return `${y.toString().padStart(4, "0")}-01-01`;
  }

  return undefined;
}

function isCopilotPremiumRequest(product: string, sku: string): boolean {
  const p = product.toLowerCase();
  const s = sku.toLowerCase();
  return p.includes("copilot") && s.includes("premium request");
}

function monthKey(year: number, month: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
}

function buildMonthlyWindows(count: number): Array<{ year: number; month: number; isCurrent: boolean }> {
  const now = new Date();
  const windows: Array<{ year: number; month: number; isCurrent: boolean }> = [];

  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    windows.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      isCurrent: i === 0,
    });
  }

  return windows;
}

async function fetchGitHubPremiumRequestUsageMonth(
  token: string,
  isOrg: boolean,
  target: string,
  year: number,
  month: number,
): Promise<Array<z.infer<typeof githubUsageBucketSchema>>> {
  const endpoint = new URL(
    isOrg
      ? `https://api.github.com/organizations/${encodeURIComponent(target)}/settings/billing/premium_request/usage`
      : `https://api.github.com/users/${encodeURIComponent(target)}/settings/billing/premium_request/usage`,
  );
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
    throw new Error(`GitHub API ${response.status} for ${year}-${String(month).padStart(2, "0")}: ${detail || response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  const parsed = githubUsageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`GitHub premium request usage returned unexpected shape for ${year}-${String(month).padStart(2, "0")}.`);
  }

  return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
}

async function fetchGitHubBillingUsageMonth(
  token: string,
  isOrg: boolean,
  target: string,
  year: number,
  month: number,
): Promise<Array<z.infer<typeof githubBillingUsageItemSchema>>> {
  const endpoint = new URL(
    isOrg
      ? `https://api.github.com/organizations/${encodeURIComponent(target)}/settings/billing/usage`
      : `https://api.github.com/users/${encodeURIComponent(target)}/settings/billing/usage`,
  );
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
    throw new Error(`GitHub API ${response.status} for ${year}-${String(month).padStart(2, "0")}: ${detail || response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  const parsed = githubBillingUsageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`GitHub billing usage returned unexpected shape for ${year}-${String(month).padStart(2, "0")}.`);
  }

  return parsed.data.usageItems ?? parsed.data.usage_items ?? [];
}

function toRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickString(record: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function pickNumber(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function normalizeDayKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const direct = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) {
    return `${direct[1]}-${direct[2]}-${direct[3]}`;
  }

  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString().slice(0, 10);
}

function extractDayKey(record: JsonRecord): string | undefined {
  const direct = pickString(record, ["day", "date", "report_day", "usage_day"]);
  const normalized = normalizeDayKey(direct);
  if (normalized) {
    return normalized;
  }

  const tp = toRecord(record.timePeriod ?? record.time_period);
  if (!tp) {
    return undefined;
  }

  const y = pickNumber(tp, ["year"]);
  const m = pickNumber(tp, ["month"]);
  const d = pickNumber(tp, ["day"]);

  if (typeof y === "number" && typeof m === "number" && typeof d === "number") {
    return `${Math.trunc(y).toString().padStart(4, "0")}-${Math.trunc(m).toString().padStart(2, "0")}-${Math.trunc(d).toString().padStart(2, "0")}`;
  }

  return undefined;
}

function isChatLikeFeature(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return /(chat|ask|agent|edit)/i.test(value);
}

function hasChatNamedField(record: JsonRecord): boolean {
  return Object.keys(record).some((key) => key.toLowerCase().includes("chat"));
}

function addToBreakdown(map: Map<string, UsageBreakdownItem>, label: string, used: number): void {
  const cleanLabel = label.trim() || "default";
  const current = map.get(cleanLabel);
  if (current) {
    current.used += used;
    return;
  }

  map.set(cleanLabel, {
    label: cleanLabel,
    used,
    cost: 0,
  });
}

function addToDaily(map: Map<string, { used: number; cost: number }>, day: string | undefined, used: number): void {
  if (!day) {
    return;
  }

  const current = map.get(day) ?? { used: 0, cost: 0 };
  current.used += used;
  map.set(day, current);
}

function parseJsonOrNdjson(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }

    const obj = toRecord(parsed);
    if (!obj) {
      return [];
    }

    const data = toArray(obj.data);
    if (data.length > 0) {
      return data;
    }

    const records = toArray(obj.records);
    if (records.length > 0) {
      return records;
    }

    return [obj];
  } catch {
    const rows: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const value = line.trim();
      if (!value) {
        continue;
      }
      try {
        rows.push(JSON.parse(value) as unknown);
      } catch {
        // ignore non-JSON lines
      }
    }

    return rows;
  }
}

function shouldSendAuthHeader(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();
    return host === "api.github.com" || host.endsWith(".ghe.com");
  } catch {
    return false;
  }
}

async function downloadReportRecords(downloadLink: string, token: string): Promise<unknown[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "usage-limits-opentui",
  };

  if (shouldSendAuthHeader(downloadLink)) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }

  const response = await fetch(downloadLink, { headers });
  if (!response.ok) {
    const body = await response.text();
    const detail = body.length > 160 ? `${body.slice(0, 157)}...` : body;
    throw new Error(`GitHub report download ${response.status}: ${detail || response.statusText}`);
  }

  const body = await response.text();
  return parseJsonOrNdjson(body);
}

function collectLegacyChatMetrics(
  record: JsonRecord,
  breakdown: Map<string, UsageBreakdownItem>,
  byDay: Map<string, { used: number; cost: number }>,
): number {
  const day = extractDayKey(record);
  let total = 0;

  const ideChat = toRecord(record.copilot_ide_chat);
  if (ideChat) {
    for (const editorValue of toArray(ideChat.editors)) {
      const editor = toRecord(editorValue);
      if (!editor) {
        continue;
      }

      const editorName = pickString(editor, ["name", "editor", "ide"]) ?? "ide";
      for (const modelValue of toArray(editor.models)) {
        const model = toRecord(modelValue);
        if (!model) {
          continue;
        }

        const chats = pickNumber(model, ["total_chats"]);
        if (typeof chats !== "number" || chats <= 0) {
          continue;
        }

        const modelName = pickString(model, ["name", "model"]) ?? "default";
        addToBreakdown(breakdown, `${editorName}/${modelName}`, chats);
        total += chats;
      }
    }
  }

  const dotcomChat = toRecord(record.copilot_dotcom_chat);
  if (dotcomChat) {
    for (const modelValue of toArray(dotcomChat.models)) {
      const model = toRecord(modelValue);
      if (!model) {
        continue;
      }

      const chats = pickNumber(model, ["total_chats"]);
      if (typeof chats !== "number" || chats <= 0) {
        continue;
      }

      const modelName = pickString(model, ["name", "model"]) ?? "default";
      addToBreakdown(breakdown, `dotcom/${modelName}`, chats);
      total += chats;
    }
  }

  addToDaily(byDay, day, total);
  return total;
}

function collectChatCountFromEntry(
  entry: JsonRecord,
  fallbackDay: string | undefined,
  fallbackIde: string | undefined,
  breakdown: Map<string, UsageBreakdownItem>,
  byDay: Map<string, { used: number; cost: number }>,
): number {
  const day = extractDayKey(entry) ?? fallbackDay;
  const feature = pickString(entry, ["feature", "chat_mode", "mode", "surface", "copilot_feature"]);
  const hasChatField = hasChatNamedField(entry);

  const explicitChatCount = pickNumber(entry, [
    "total_chats",
    "total_chat_requests",
    "chat_requests",
    "chat_request_count",
    "total_chat_count",
  ]);

  let count = explicitChatCount;
  if (typeof count !== "number") {
    const interactions = pickNumber(entry, ["user_initiated_interaction_count", "interaction_count"]);
    if (typeof interactions === "number" && (hasChatField || isChatLikeFeature(feature))) {
      count = interactions;
    }
  }

  if (typeof count !== "number" || count <= 0) {
    return 0;
  }

  const ide = fallbackIde ?? pickString(entry, ["ide", "editor", "ide_name", "client", "platform"]);
  const model = pickString(entry, ["model", "model_name", "model_id", "name"]) ?? "default";
  const label = ide ? `${ide}/${model}` : model;

  addToBreakdown(breakdown, label, count);
  addToDaily(byDay, day, count);
  return count;
}

function collectUsageMetricsFromRecord(
  record: JsonRecord,
  breakdown: Map<string, UsageBreakdownItem>,
  byDay: Map<string, { used: number; cost: number }>,
): number {
  const fallbackDay = extractDayKey(record);
  let total = 0;

  const ideGroups = toArray(record.totals_by_ide ?? record.totalsByIde);
  for (const ideGroupValue of ideGroups) {
    const ideGroup = toRecord(ideGroupValue);
    if (!ideGroup) {
      continue;
    }

    const ideName = pickString(ideGroup, ["ide", "editor", "name", "ide_name"]);
    const ideModelRows = toArray(ideGroup.totals_by_model_feature ?? ideGroup.totalsByModelFeature ?? ideGroup.totals_by_feature_model);

    if (ideModelRows.length > 0) {
      for (const row of ideModelRows) {
        const rec = toRecord(row);
        if (!rec) {
          continue;
        }
        total += collectChatCountFromEntry(rec, fallbackDay, ideName, breakdown, byDay);
      }
      continue;
    }

    total += collectChatCountFromEntry(ideGroup, fallbackDay, ideName, breakdown, byDay);
  }

  const topModelRows = toArray(record.totals_by_model_feature ?? record.totalsByModelFeature ?? record.totals_by_feature_model);
  if (topModelRows.length > 0) {
    for (const row of topModelRows) {
      const rec = toRecord(row);
      if (!rec) {
        continue;
      }
      total += collectChatCountFromEntry(rec, fallbackDay, undefined, breakdown, byDay);
    }
  }

  const featureRows = toArray(record.totals_by_feature ?? record.totalsByFeature);
  if (featureRows.length > 0) {
    for (const row of featureRows) {
      const rec = toRecord(row);
      if (!rec) {
        continue;
      }
      total += collectChatCountFromEntry(rec, fallbackDay, undefined, breakdown, byDay);
    }
  }

  if (total <= 0) {
    total += collectChatCountFromEntry(record, fallbackDay, undefined, breakdown, byDay);
  }

  return total;
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

async function fetchGitHubCopilotUsage(cfg: AgentConfig, onUpdate?: (partial: Partial<UsageResult>) => void): Promise<UsageResult> {
  const token = ensureConfigured(cfg.token, "GitHub token");
  const identity = ensureConfigured(cfg.username, "GitHub username (or org:slug)");
  const isOrg = identity.toLowerCase().startsWith("org:");
  const target = isOrg ? identity.slice(4).trim() : identity;
  if (!target) {
    throw new Error("Missing GitHub username/org value.");
  }

  const months = buildMonthlyWindows(24);

  const current = months[0];
  if (!current) {
    throw new Error("Unable to resolve current month window.");
  }

  const currentBuckets = await fetchGitHubPremiumRequestUsageMonth(token, isOrg, target, current.year, current.month);

  const byDay = new Map<string, { used: number; cost: number }>();
  const currentByModel = new Map<string, UsageBreakdownItem>();
  let currentUsed = 0;
  let currentCost = 0;
  let currentDiscountQuantity = 0;

  for (const bucket of currentBuckets) {
    const items = bucket.usageItems ?? bucket.usage_items ?? [];
    for (const item of items) {
      if (!isCopilotPremiumRequest(item.product, item.sku)) {
        continue;
      }

      const quantity = valueOrZero(item.grossQuantity) || valueOrZero(item.netQuantity);
      const amount = valueOrZero(item.netAmount) || valueOrZero(item.grossAmount);

      currentUsed += quantity;
      currentCost += amount;
      currentDiscountQuantity += valueOrZero(item.discountQuantity);

      const existing = currentByModel.get(item.model);
      if (existing) {
        existing.used += quantity;
        existing.cost += amount;
      } else {
        currentByModel.set(item.model, {
          label: item.model,
          used: quantity,
          cost: amount,
        });
      }
    }
  }

  // Immediately report the main usage so the dashboard updates while history loads
  if (onUpdate) {
    onUpdate({
      used: currentUsed,
      cost: currentCost,
      breakdown: [...currentByModel.values()].sort((a, b) => b.used - a.used),
    });
  }

  // Fetch history across 24 months sequentially to avoid rate limits and update incrementally
  let fetchedCount = 1; // monthly premium request usage (current month) is already done
  for (const window of months) {
    try {
      const usageItems = await fetchGitHubBillingUsageMonth(token, isOrg, target, window.year, window.month);
      let changedInMonth = false;
      fetchedCount += 1;

      for (const item of usageItems) {
        if (!item.product.toLowerCase().includes("copilot")) {
          continue;
        }

        const day = normalizeDayKey(item.date);
        if (!day) {
          continue;
        }

        const quantity = valueOrZero(item.quantity);
        const amount = valueOrZero(item.netAmount) || valueOrZero(item.grossAmount);
        const currentValue = byDay.get(day) ?? { used: 0, cost: 0 };
        currentValue.used += quantity;
        currentValue.cost += amount;
        byDay.set(day, currentValue);
        changedInMonth = true;
      }

      if (changedInMonth && onUpdate) {
        const daily: DailyUsagePoint[] = [...byDay.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([day, value]) => ({ day, used: value.used, cost: value.cost }));
        onUpdate({ daily, fetchedMonths: fetchedCount });
      }

      // Small delay to be polite to the API and let UI render
      await new Promise((resolve) => setTimeout(resolve, 30));
    } catch {
      // Swallow errors for past months to show whatever data we CAN get
    }
  }

  const breakdown = [...currentByModel.values()].sort((a, b) => b.used - a.used);
  const details: string[] = [
    `${isOrg ? "GitHub org" : "GitHub user"}: ${target}`,
    `Current month: ${current ? monthKey(current.year, current.month) : "n/a"}`,
    `Trend window: 24 months (${byDay.size} days found)`,
    `Included quantity (current month): ${currentDiscountQuantity.toFixed(2)} req`,
    isOrg
      ? "Endpoint: /organizations/{org}/settings/billing/premium_request/usage"
      : "Endpoint: /users/{username}/settings/billing/premium_request/usage",
  ];

  if (breakdown.length === 0) {
    details.push("No Copilot premium request rows returned for current month.");
  }

  const daily: DailyUsagePoint[] = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, value]) => ({ day, used: value.used, cost: value.cost }));

  return {
    used: currentUsed,
    limit: cfg.billingMode === "quota" ? cfg.monthlyLimit : undefined,
    unit: "req",
    cost: currentCost,
    details,
    breakdown,
    daily,
    fetchedMonths: fetchedCount,
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
    fetchUsage: async (cfg, onUpdate) => {
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
    description: "Live Copilot premium request usage via GitHub billing usage API.",
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
  keyProvider("ollama", "Ollama", "#ffffff", "Ollama usage (manual until API adapter is added).", "payg"),
  keyProvider("openrouter", "OpenRouter", "#6933ff", "OpenRouter usage (manual until API adapter is added).", "payg"),
  keyProvider("cursor", "Cursor", "#5ed7ff", "Cursor usage (manual until API adapter is added).", "payg"),
  keyProvider("antigravity", "Antigravity (Google)", "#4285f4", "Google Antigravity usage (manual until API adapter is added).", "payg"),
  keyProvider("opencode", "OpenCode", "#ff3e00", "OpenCode usage (manual until API adapter is added).", "payg"),
];

export function getProvider(key: AgentKey): AgentProvider {
  const found = PROVIDERS.find((provider) => provider.key === key);
  if (!found) {
    throw new Error(`Unknown provider: ${key}`);
  }

  return found;
}
