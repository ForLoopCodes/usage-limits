import { Box, Text, createCliRenderer, fg, t, type KeyEvent, type PasteEvent } from "@opentui/core";
import { loadConfig, saveConfig } from "./config";
import { getProvider, PROVIDERS } from "./providers";
import { THEMES, getTheme, type ThemeDefinition } from "./themes";
import type { AgentKey, AgentProvider, AgentSnapshot, BillingMode, DailyUsagePoint, HeatmapInfoMode, HeatmapScope, Screen } from "./types";
import { BAR_STYLE_OPTIONS, REFRESH_PRESETS, SETTINGS_PAGES } from "./ui/constants";
import { toBar } from "./ui/format";

const DEFAULT_AGENT: AgentKey = "github-copilot";

type DetailPaneMode = "sidebar" | "bottom" | "hidden";
type SettingsPageKey = (typeof SETTINGS_PAGES)[number]["key"];
type ModelFieldKey = "enabled" | "billingMode" | "credential" | "accentColor" | "username" | "monthlyLimit" | "costLimit" | "manualUsed" | "manualCost";
type UiRowKey =
  | "theme"
  | "barStyle"
  | "refreshSeconds"
  | "detailPaneMode"
  | "dashboardMetrics"
  | "showModeColumn"
  | "heatmapScope"
  | "heatmapProvider"
  | "heatmapMetric"
  | "heatmapChars"
  | "heatmapCellWidth"
  | "heatmapInfoMode"
  | "heatmapPaletteSteps"
  | "heatmapMaxDays"
  | "decimalPlaces";

// Locally extend AppConfig to include detailPaneMode field
type AppConfigWithDetailPane = ReturnType<typeof loadConfig> & { detailPaneMode?: DetailPaneMode };

interface PromptState {
  providerKey: AgentKey;
  title: string;
  instructions: string[];
  value: string;
  secret: boolean;
  mode: "text" | "number";
  onSubmit: (value: string) => void;
}

interface ProviderRow {
  kind: "provider";
  providerKey: AgentKey;
}

interface FieldRow {
  kind: "field";
  providerKey: AgentKey;
  field: ModelFieldKey;
}

type ModelRow = ProviderRow | FieldRow;

interface AppState {
  screen: Screen;
  config: ReturnType<typeof loadConfig> & { detailPaneMode?: DetailPaneMode };
  snapshots: Record<AgentKey, AgentSnapshot>;
  dashboardSelection: number;
  settingsNavFocused: boolean;
  settingsPage: SettingsPageKey;
  modelSelection: number;
  uiSelection: number;
  expandedProviders: Record<AgentKey, boolean>;
  prompt: PromptState | null;
  promptCursorVisible: boolean;
  promptCursorTimer: Timer | null;
  themePopupOpen: boolean;
  themePopupSelection: number;
  themePopupPreviousTheme: string | null;
  refreshing: boolean;
  lastUpdatedAt: string;
  refreshTimer: Timer | null;
  animationFrame: number;
  resizeWatchTimer: Timer | null;
  statusLine: string;
  shuttingDown: boolean;
}

function fieldDescription(field: ModelFieldKey): string {
  switch (field) {
    case "enabled":
      return "Toggle provider availability";
    case "billingMode":
      return "Choose quota or pay-as-you-go";
    case "credential":
      return "Token / API key editor";
    case "accentColor":
      return "Custom color for this provider row";
    case "username":
      return "Username for billing usage API (or org:slug)";
    case "monthlyLimit":
      return "Usage budget cap";
    case "costLimit":
      return "Monthly spend budget cap";
    case "manualUsed":
      return "Manual usage fallback value";
    case "manualCost":
      return "Manual cost fallback value";
    default:
      return "";
  }
}

function blankSnapshot(provider: AgentProvider, enabled: boolean, billingMode: BillingMode): AgentSnapshot {
  return {
    key: provider.key,
    label: provider.label,
    accent: provider.accent,
    enabled,
    configured: false,
    billingMode,
    loading: false,
    used: 0,
    limit: undefined,
    unit: "req",
    cost: 0,
    progress: 0,
    details: [provider.description],
    breakdown: [],
    daily: [],
    fetchedMonths: 0,
    revealCursor: 0,
    fetchedAt: undefined,
  };
}

function createInitialSnapshots(): Record<AgentKey, AgentSnapshot> {
  return {
    "github-copilot": blankSnapshot(getProvider("github-copilot"), true, "quota"),
    codex: blankSnapshot(getProvider("codex"), false, "quota"),
    claude: blankSnapshot(getProvider("claude"), false, "quota"),
    zai: blankSnapshot(getProvider("zai"), false, "quota"),
    minimax: blankSnapshot(getProvider("minimax"), false, "quota"),
    "vercel-ai": blankSnapshot(getProvider("vercel-ai"), false, "payg"),
    ollama: blankSnapshot(getProvider("ollama"), false, "payg"),
    openrouter: blankSnapshot(getProvider("openrouter"), false, "payg"),
    cursor: blankSnapshot(getProvider("cursor"), false, "payg"),
    antigravity: blankSnapshot(getProvider("antigravity"), false, "payg"),
    opencode: blankSnapshot(getProvider("opencode"), false, "payg"),
  };
}

function pickConfiguredProgress(mode: BillingMode, used: number, limit: number | undefined): number {
  if (mode === "payg") {
    return 1;
  }

  if (typeof limit !== "number" || limit <= 0) {
    return 1;
  }

  return clamp(used / limit, 0, 1);
}

export async function run(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  });

  const loadedConfig = loadConfig();

  const state: AppState = {
    screen: "dashboard",
    config: loadedConfig,
    snapshots: createInitialSnapshots(),
    dashboardSelection: 0,
    settingsNavFocused: false,
    settingsPage: "model-settings",
    modelSelection: 0,
    uiSelection: 0,
    expandedProviders: {
      "github-copilot": true,
      codex: false,
      claude: false,
      zai: false,
      minimax: false,
      "vercel-ai": false,
      ollama: false,
      openrouter: false,
      cursor: false,
      antigravity: false,
      opencode: false,
    },
    prompt: null,
    promptCursorVisible: true,
    promptCursorTimer: null,
    themePopupOpen: false,
    themePopupSelection: Math.max(0, THEMES.findIndex((theme) => theme.key === loadedConfig.theme)),
    themePopupPreviousTheme: null,
    refreshing: false,
    lastUpdatedAt: "--:--:--",
    refreshTimer: null,
    animationFrame: 0,
    resizeWatchTimer: null,
    statusLine: "ready",
    shuttingDown: false,
  };

  setInterval(() => {
    let needsRedraw = false;
    let isAnySweeping = false;

    // Sweep reveal cursors for all snapshots
    for (const key of providerOrder) {
      const snap = state.snapshots[key];
      const heatmapCellWidth = clamp(state.config.heatmapCellWidth ?? 1, 1, 4);

      const targetCursor = Math.floor((snap.fetchedMonths ?? 0) * 4.3452 * heatmapCellWidth);

      if ((snap.revealCursor ?? 0) < targetCursor) {
        snap.revealCursor = (snap.revealCursor ?? 0) + 1;
        needsRedraw = true;
        isAnySweeping = true;
      }
    }

    if (state.refreshing || isAnySweeping) {
      state.animationFrame = (state.animationFrame + 1) % 1000;
      needsRedraw = true;
    }

    if (needsRedraw) {
      redraw();
    }
  }, 50);

  const providerOrder = PROVIDERS.map((provider) => provider.key);
  const APP_PAD_X = 2;
  const APP_PAD_Y = 1;
  const APP_MAX_WIDTH = 140;

  function getViewportWidth(): number {
    return clamp(renderer.width - APP_PAD_X * 2, 24, APP_MAX_WIDTH);
  }

  function getViewportHeight(): number {
    return Math.max(8, renderer.height - APP_PAD_Y * 2);
  }

  function getViewportLeft(): number {
    return Math.max(0, Math.floor((renderer.width - getViewportWidth()) / 2));
  }

  function save(): void {
    saveConfig(state.config);
  }

  function getThemeSafe(): ThemeDefinition {
    return getTheme(state.config.theme);
  }

  function getEnabledProviderKeys(): AgentKey[] {
    return providerOrder.filter((key) => state.config.agents[key].enabled);
  }

  function selectedProviderFromDashboard(): AgentKey | undefined {
    const keys = getEnabledProviderKeys();
    if (keys.length === 0) {
      return undefined;
    }

    state.dashboardSelection = clamp(state.dashboardSelection, 0, keys.length - 1);
    return keys[state.dashboardSelection];
  }

  function getUsageParts(key: AgentKey): { used: string; max: string } {
    const snapshot = state.snapshots[key];
    const cfg = state.config.agents[key];
    const used = snapshot.unit === "req" ? formatNumber(snapshot.used) : `${formatNumber(snapshot.used)}${snapshot.unit}`;
    const max = cfg.billingMode === "quota" ? (typeof cfg.monthlyLimit === "number" ? formatNumber(cfg.monthlyLimit) : "∞") : "∞";
    return { used, max };
  }

  function getCostParts(key: AgentKey): { current: string; max: string } {
    const snapshot = state.snapshots[key];
    const cfg = state.config.agents[key];
    const max = typeof cfg.costLimit === "number" ? formatMoney(cfg.costLimit) : "∞";
    return { current: formatMoney(snapshot.cost), max };
  }

  function openPrompt(prompt: PromptState): void {
    state.prompt = prompt;
    state.themePopupOpen = false;

    // start caret blink for prompt input
    state.promptCursorVisible = true;
    if (state.promptCursorTimer) {
      clearInterval(state.promptCursorTimer);
      state.promptCursorTimer = null;
    }
    state.promptCursorTimer = setInterval(() => {
      state.promptCursorVisible = !state.promptCursorVisible;
      redraw();
    }, 500);

    redraw();
  }

  function closePrompt(): void {
    state.prompt = null;

    // stop caret blink
    if (state.promptCursorTimer) {
      clearInterval(state.promptCursorTimer);
      state.promptCursorTimer = null;
    }
    state.promptCursorVisible = false;

    redraw();
  }

  function openTextPrompt(providerKey: AgentKey, current: string | undefined, instructions: string[], onApply: (next: string | undefined) => void): void {
    openPrompt({
      providerKey,
      title: getProvider(providerKey).label,
      instructions,
      value: current ?? "",
      secret: false,
      mode: "text",
      onSubmit: (value) => {
        const trimmed = value.trim();
        onApply(trimmed.length > 0 ? trimmed : undefined);
        save();
        closePrompt();
        void refreshUsage("settings");
      },
    });
  }

  function openNumberPrompt(providerKey: AgentKey, current: number | undefined, instructions: string[], onApply: (next: number | undefined) => void): void {
    openPrompt({
      providerKey,
      title: getProvider(providerKey).label,
      instructions,
      value: typeof current === "number" ? String(current) : "",
      secret: false,
      mode: "number",
      onSubmit: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          onApply(undefined);
          save();
          closePrompt();
          void refreshUsage("settings");
          return;
        }

        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed < 0) {
          state.statusLine = "invalid number";
          redraw();
          return;
        }

        onApply(parsed);
        save();
        closePrompt();
        void refreshUsage("settings");
      },
    });
  }

  function openAppTextPrompt(title: string, current: string | undefined, instructions: string[], onApply: (next: string | undefined) => void): void {
    openPrompt({
      providerKey: DEFAULT_AGENT,
      title,
      instructions,
      value: current ?? "",
      secret: false,
      mode: "text",
      onSubmit: (value) => {
        const trimmed = value.trim();
        onApply(trimmed.length > 0 ? trimmed : undefined);
        save();
        closePrompt();
        redraw();
      },
    });
  }

  function toDayKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  function fromDayKey(day: string): Date | null {
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  function normalizeDailyUsage(input: DailyUsagePoint[] | undefined): DailyUsagePoint[] {
    const valid = (input ?? [])
      .filter((item) => Number.isFinite(item.used) && Number.isFinite(item.cost) && Boolean(fromDayKey(item.day)))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return valid;
  }

  function sumDailyUsageSeries(seriesList: DailyUsagePoint[][]): DailyUsagePoint[] {
    const byDay = new Map<string, { used: number; cost: number }>();

    for (const series of seriesList) {
      for (const item of series) {
        const current = byDay.get(item.day) ?? { used: 0, cost: 0 };
        current.used += item.used;
        current.cost += item.cost;
        byDay.set(item.day, current);
      }
    }

    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([day, value]) => ({ day, used: value.used, cost: value.cost }));
  }

  function isoWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  function heatmapPalette(stepCount: number, accentColor: string, appBg: string): string[] {
    const steps = clamp(stepCount, 2, 9);

    const parseHex = (hex: string): [number, number, number] | null => {
      const value = hex.trim().replace("#", "");
      if (!/^[0-9a-fA-F]{6}$/.test(value)) {
        return null;
      }
      const r = Number.parseInt(value.slice(0, 2), 16);
      const g = Number.parseInt(value.slice(2, 4), 16);
      const b = Number.parseInt(value.slice(4, 6), 16);
      if (![r, g, b].every((v) => Number.isFinite(v))) {
        return null;
      }
      return [r, g, b];
    };

    const toHex = (v: number): string => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");

    const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];

    const bg = parseHex(appBg) ?? [22, 27, 34];
    const fg = parseHex(accentColor) ?? [57, 211, 83];

    return Array.from({ length: steps }, (_, i) => {
      const t = steps <= 1 ? 1 : i / (steps - 1);
      const [r, g, b] = mix(bg, fg, 0.12 + t * 0.88);
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    });
  }

  function pickHeatmapChar(charSet: string): string {
    const source = Array.from((charSet || "⣿").trim());
    return source[0] ?? "⣿";
  }

  function openCredentialPrompt(providerKey: AgentKey): void {
    const provider = getProvider(providerKey);

    if (providerKey === "github-copilot") {
      openPrompt({
        providerKey,
        title: provider.label,
        instructions: [
          "GitHub token: fine-grained PAT or GitHub App user token",
          "Permission needed: Plan (read) for users, Administration (read) for organizations",
          "Get token from GitHub Settings → Developer settings",
        ],
        value: "",
        secret: true,
        mode: "text",
        onSubmit: (value) => {
          const token = value.trim();
          if (token) {
            state.config.agents[providerKey].token = token;
            save();
          }

          openTextPrompt(
            providerKey,
            state.config.agents[providerKey].username,
            ["Enter your GitHub username/handle", "Used in /users/{username}/settings/billing/premium_request/usage (or org:slug for organizations)"],
            (next) => {
              state.config.agents[providerKey].username = next;
            },
          );
        },
      });
      return;
    }

    openPrompt({
      providerKey,
      title: provider.label,
      instructions: [
        `Paste ${provider.label} API key`,
        "Use key from provider dashboard or account settings",
      ],
      value: "",
      secret: true,
      mode: "text",
      onSubmit: (value) => {
        const apiKey = value.trim();
        if (apiKey) {
          state.config.agents[providerKey].apiKey = apiKey;
          save();
        }
        closePrompt();
        void refreshUsage("credential");
      },
    });
  }

  function ensureFirstMissingConfigPrompt(): void {
    const key = providerOrder.find((providerKey) => {
      const provider = getProvider(providerKey);
      return state.config.agents[providerKey].enabled && !provider.isConfigured(state.config.agents[providerKey]);
    });

    if (!key || state.prompt || state.themePopupOpen) {
      return;
    }

    state.screen = "settings";
    state.settingsPage = "model-settings";
    state.expandedProviders[key] = true;
    openCredentialPrompt(key);
  }

  function buildHeader(theme: ThemeDefinition, width: any = "100%") {
    const refreshChunk = `${formatRefresh(state.config.refreshSeconds)} ${state.lastUpdatedAt}`;

    return Box(
      {
        width: width,
        backgroundColor: theme.appBg,
        paddingLeft: width === "100%" ? 1 : 0,
        paddingRight: width === "100%" ? 1 : 0,
        flexDirection: "row",
        justifyContent: "space-between",
      },
      Text({ content: t`${fg(theme.success)("DIST - Did I Ship Today?")}`, truncate: true }),
      Text({ content: refreshChunk, fg: theme.success, truncate: true }),
    );
  }

  function buildCommandBar(theme: ThemeDefinition, width: any = "100%") {
    const segments =
      state.screen === "dashboard"
        ? [
          ["q", "quit"],
          ["r", "refresh"],
          ["s", "settings"],
          ["↑/↓", "select"],
        ]
        : [
          ["q", "quit"],
          ["d", "dashboard"],
          ["tab", "focus"],
          ["↑/↓", "move"],
          ["a/d", "change"],
          ["enter", "edit"],
          ["space", "toggle"],
        ];

    const SEGMENT_GAP = "   ";
    const STATUS_GAP = "    ";

    const items = segments.flatMap(([key, label], index) => {
      const tail = index < segments.length - 1 ? [Text({ content: SEGMENT_GAP, fg: theme.muted })] : [];
      return [
        Text({ content: key, fg: theme.success }),
        Text({ content: ` ${label}`, fg: theme.muted }),
        ...tail,
      ];
    });

    items.push(Text({ content: STATUS_GAP, fg: theme.muted }));
    items.push(Text({ content: state.statusLine, fg: theme.text, truncate: true }));

    return Box(
      {
        width: width,
        backgroundColor: theme.appBg,
        flexDirection: "row",
        justifyContent: width === "100%" ? "center" : "flex-start",
        paddingLeft: width === "100%" ? 1 : 0,
        paddingRight: width === "100%" ? 1 : 0,
      },
      ...items,
    );
  }

  function buildDetailPane(
    theme: ThemeDefinition,
    key: AgentKey,
    width: number,
    colPct?: { modelPct: number; reqPct: number; costPct?: number },
    showReq = true,
    showCost = true,
  ) {
    const snapshot = state.snapshots[key];

    const fadeColors = [theme.text, "#b8c0d4", "#9aa4c0", "#808ca8", theme.muted];

    // detail table width should match the passed pane width exactly
    const paneWidth = Math.max(12, Math.floor(width));
    const GAP = 2;
    const MIN = { model: 12, req: 6, cost: 6 };

    // determine which metric columns should be shown (follow dashboard setting)
    const metrics = state.config.dashboardMetrics ?? "both";
    const showReqCol = (metrics === "both" || metrics === "req") && showReq;
    const showCostCol = (metrics === "both" || metrics === "cost") && showCost;

    // start with conservative, model-first allocation so names don't truncate
    let modelCol = Math.max(MIN.model, Math.floor(paneWidth * (colPct?.modelPct ?? 0.65)));
    let reqCol = showReqCol ? Math.max(MIN.req, Math.floor(paneWidth * (colPct?.reqPct ?? 0.08))) : 0;
    let costCol = showCostCol ? Math.max(MIN.cost, Math.floor(paneWidth * (colPct?.costPct ?? 0.12))) : 0;

    // ensure columns + gaps fit — if not, shrink metric cols first, then model
    const gapCount = (showCostCol ? 1 : 0) + (showReqCol ? 1 : 0);
    while (modelCol + reqCol + costCol + gapCount * GAP > paneWidth) {
      if (reqCol > MIN.req) reqCol -= 1;
      else if (costCol > MIN.cost) costCol -= 1;
      else if (modelCol > MIN.model) modelCol -= 1;
      else break;
    }

    // give any leftover space to the model column so it doesn't truncate names
    const used = modelCol + reqCol + costCol + gapCount * GAP;
    if (used < paneWidth) {
      modelCol += paneWidth - used;
    }

    // helper that renders columns in order: model | cost? | req?
    function detailRow(model: string, req: string, cost: string, color: string) {
      const parts: any[] = [];
      const lastDetailCol: "model" | "cost" | "req" = showReqCol ? "req" : showCostCol ? "cost" : "model";

      parts.push(Box({ width: modelCol }, Text({ content: fit(model, modelCol), fg: color, truncate: true })));

      if (showCostCol) {
        parts.push(Box({ width: GAP }));
        const cText = cost.trim();
        parts.push(Box({ width: costCol }, Text({ content: fit(cText, costCol), fg: color, truncate: true })));
      }

      if (showReqCol) {
        parts.push(Box({ width: GAP }));
        parts.push(Box({ width: reqCol }, Text({ content: fit(req, reqCol), fg: color, truncate: true })));
      }

      return Box(
        {
          width: paneWidth,
          flexDirection: "row",
          backgroundColor: "transparent",
        },
        ...parts,
      );
    }

    const modelRows = snapshot.breakdown.slice(0, 5).map((item, index) => {
      const c = fadeColors[index] ?? theme.muted;
      return detailRow(item.label, `${formatNumber(item.used)}`, formatMoney(item.cost), c);
    });

    // ----------------------
    // Daily usage heatmap
    // ----------------------
    const selectedModel = snapshot.breakdown[0];
    const heatmapMetric = state.config.heatmapMetric ?? "req";
    const heatmapChars = (state.config.heatmapChars?.trim() || "⣿");
    const heatmapCellWidth = clamp(state.config.heatmapCellWidth ?? 1, 1, 4);
    const heatmapSteps = clamp(state.config.heatmapPaletteSteps ?? 7, 2, 9);
    const heatmapMaxDays = clamp(state.config.heatmapMaxDays ?? 364, 7, 364);
    const heatmapInfoMode: HeatmapInfoMode = state.config.heatmapInfoMode ?? "days";
    const heatmapScope: HeatmapScope = state.config.heatmapScope ?? "focused";
    const hp = state.config.heatmapProvider ?? DEFAULT_AGENT;
    const configuredHeatmapProvider: AgentKey = (hp === ("all" as any) ? DEFAULT_AGENT : hp) as AgentKey;

    const enabledSnapshots = providerOrder
      .filter((providerKey) => state.config.agents[providerKey].enabled)
      .map((providerKey) => state.snapshots[providerKey])
      .filter((item): item is AgentSnapshot => Boolean(item));

    const totalDaily = sumDailyUsageSeries(enabledSnapshots.map((item) => normalizeDailyUsage(item.daily)));

    let graphDailyRaw: DailyUsagePoint[] = [];
    let scopeAccent = theme.success;
    let useQuotaPercent = false;
    let quotaBase = 300;

    if (heatmapScope === "total") {
      graphDailyRaw = totalDaily;
      scopeAccent = theme.success;
      useQuotaPercent = false;
    } else {
      const resolvedProviderKey: AgentKey = (heatmapScope === "provider" ? configuredHeatmapProvider : key) as AgentKey;
      const scopedSnapshot = state.snapshots[resolvedProviderKey] ?? snapshot;
      graphDailyRaw = normalizeDailyUsage(scopedSnapshot.daily);
      scopeAccent = scopedSnapshot.accent || theme.success;
      quotaBase = Math.max(1, state.config.agents[resolvedProviderKey]?.monthlyLimit ?? 300);
      useQuotaPercent = heatmapMetric === "req" && resolvedProviderKey === "github-copilot";
    }

    const graphDaily = useQuotaPercent
      ? graphDailyRaw.map((item) => ({
        ...item,
        used: Number(((item.used / quotaBase) * 100).toFixed(1)),
      }))
      : graphDailyRaw;

    // Calculate columns based on max days, then trim from left to fit paneWidth
    const requestedCols = clamp(Math.ceil(heatmapMaxDays / 7), 1, 52);
    const maxAvailableCols = Math.floor((paneWidth - 2) / heatmapCellWidth);
    const cols = Math.min(requestedCols, maxAvailableCols);

    const totalCells = cols * 7;
    const palette = heatmapPalette(heatmapSteps, scopeAccent, theme.appBg);
    const byDay = new Map(graphDaily.map((item) => [item.day, item]));

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - (totalCells - 1));

    const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: cols }, () => 0));
    const yearMarkers: { col: number; year: number }[] = [];
    const monthMarkers: { col: number; month: string }[] = [];
    const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let lastYear = -1;
    let lastMonth = -1;
    let maxValue = 0;

    for (let c = 0; c < cols; c += 1) {
      const dMonth = new Date(start);
      dMonth.setUTCDate(start.getUTCDate() + c * 7);
      const currentYear = dMonth.getUTCFullYear();
      const currentMonth = dMonth.getUTCMonth();

      if (currentYear !== lastYear) {
        yearMarkers.push({ col: c, year: currentYear });
        lastYear = currentYear;
      }

      if (currentMonth !== lastMonth) {
        monthMarkers.push({ col: c, month: MONTH_NAMES[currentMonth] || "" });
        lastMonth = currentMonth;
      }

      for (let r = 0; r < 7; r += 1) {
        const row = grid[r];
        if (!row) {
          continue;
        }

        const d = new Date(start);
        d.setUTCDate(start.getUTCDate() + c * 7 + r);
        const keyDay = toDayKey(d);
        const day = byDay.get(keyDay);
        const baseValue = heatmapMetric === "cost" ? (day?.cost ?? 0) : (day?.used ?? 0);
        row[c] = Math.max(0, baseValue);
        maxValue = Math.max(maxValue, row[c] ?? 0);
      }
    }

    const dayLabels = ["S", "M", "T", "W", "T", "F", "S"];
    const heatmapRows = Array.from({ length: 7 }, (_, r) => {
      const cells: any[] = [];
      const row = grid[r] ?? [];

      // Left Day Label Column
      cells.push(Box({ width: 2 }, Text({ content: dayLabels[r] ?? "", fg: theme.muted })));

      for (let c = 0; c < cols; c += 1) {
        const value = row[c] ?? 0;
        const level = maxValue <= 0 ? 0 : Math.round((value / maxValue) * (heatmapSteps - 1));
        const baseChar = pickHeatmapChar(heatmapChars);
        const color = palette[level] ?? (palette[palette.length - 1] ?? theme.success);

        for (let j = 0; j < heatmapCellWidth; j++) {
          const charIndexFromLeft = c * heatmapCellWidth + j;
          const charIndexFromRight = (cols * heatmapCellWidth) - 1 - charIndexFromLeft;

          // Reveal character by character from the right (newest) towards the left (oldest)
          const revealCursor = snapshot.revealCursor ?? 0;
          const isStillLoading = snapshot.loading && charIndexFromRight > revealCursor;

          if (isStillLoading) {
            const frame = state.animationFrame;
            // distance in characters from the reveal cursor
            const distance = Math.abs(charIndexFromRight - revealCursor);
            // Frontier is the "scanning" edge at the reveal cursor (wider for visible effect)
            const isFrontier = distance < 3.0;

            // Faster, more erratic noise for the "Chernobyl" effect
            const noise = Math.abs(Math.sin(frame * (isFrontier ? 6.5 : 2.5) + c * 0.7 + r * 1.9 + j) * 10000) % 1;

            // Random sparks/glints of color in the noise field
            const isGlint = !isFrontier && noise > 0.85;

            const glitchChars = [" ", ".", ":", "░", "·", "!", "×", "÷", "±", "·"];

            const char = glitchChars[Math.floor(noise * glitchChars.length)] ?? " ";
            // Use the brightest color from the palette for the frontier (the "scan line")
            // palette[palette.length - 1] is the most intense level
            const scanColor = palette[palette.length - 1] ?? scopeAccent;
            const fg = (isFrontier || isGlint) ? scanColor : "#1a1a1a";
            cells.push(Text({ content: char, fg }));
          } else {
            cells.push(Text({ content: baseChar, fg: color }));
          }
        }
      }

      return Box(
        {
          width: 2 + (cols * heatmapCellWidth),
          flexDirection: "row",
          height: 1,
        },
        ...cells
      );
    });

    const yearRowParts: any[] = [Box({ width: 2 })];
    let lastYPos = 2;
    for (const marker of yearMarkers) {
      const targetCol = 2 + marker.col * heatmapCellWidth;
      const skip = targetCol - lastYPos;
      if (skip > 0) {
        yearRowParts.push(Box({ width: skip }));
        lastYPos += skip;
      }
      yearRowParts.push(Text({ content: String(marker.year), fg: scopeAccent }));
      lastYPos += String(marker.year).length;
    }

    const yearRow = Box(
      { width: 2 + (cols * heatmapCellWidth), flexDirection: "row", height: 1 },
      ...yearRowParts
    );

    const monthRowParts: any[] = [Box({ width: 2 })];
    let lastMPos = 2; // Start after the initial Box({ width: 2 })
    for (const marker of monthMarkers) {
      const targetCol = 2 + marker.col * heatmapCellWidth;
      const skip = targetCol - lastMPos;
      if (skip > 0) {
        monthRowParts.push(Box({ width: skip }));
        lastMPos += skip;
      }
      monthRowParts.push(Text({ content: marker.month, fg: theme.muted }));
      lastMPos += marker.month.length;
    }

    const monthRow = Box(
      { width: 2 + (cols * heatmapCellWidth), flexDirection: "row", height: 1 },
      ...monthRowParts
    );

    const legendGlyph = pickHeatmapChar(heatmapChars);
    const legendSwatches = palette.map((color) => Text({ content: legendGlyph, fg: color }));

    const todayStr = toDayKey(new Date());
    const todayUsed = byDay.get(todayStr)?.used ?? 0;

    return Box(
      {
        width: paneWidth,
        backgroundColor: theme.appBg,
        paddingLeft: 0,
        paddingRight: 0,
        flexDirection: "column",
        alignItems: "flex-start",
      },
      (function () {
        const headerLineParts: string[] = [];

        headerLineParts.push(fit("Model", modelCol));
        if (showCostCol) headerLineParts.push(" ".repeat(GAP) + fit("Cost", costCol));
        if (showReqCol) headerLineParts.push(" ".repeat(GAP) + fit("Req", reqCol));

        return Box({ width: paneWidth }, Text({ content: headerLineParts.join(""), fg: theme.success, truncate: true }));
      })(),
      ...(modelRows.length > 0 ? modelRows : [detailRow("No model rows available", "", "", theme.muted)]),
      Text({ content: "", fg: theme.text }),
      Box(
        {
          width: paneWidth,
          flexDirection: "column",
          alignItems: "flex-start",
        },
        yearRow,
        monthRow,
        ...heatmapRows,
      ),
      Box(
        {
          width: paneWidth,
          flexDirection: "row",
          justifyContent: "space-between",
        },
        Text({ content: `Today: ${todayUsed.toFixed(2)}%`, fg: theme.muted }),
        Box(
          { flexDirection: "row" },
          Text({ content: "Low ", fg: theme.muted }),
          ...legendSwatches,
          Text({ content: " High", fg: theme.muted }),
        )
      )
    );
  }

  function resolveEffectiveDetailPaneMode(): DetailPaneMode {
    const configured = state.config.detailPaneMode ?? "sidebar";
    if (configured === "hidden") {
      return "hidden";
    }

    if (getViewportWidth() < 130) {
      return "bottom";
    }

    return configured;
  }

  function computeDashboardColumnWidths(
    totalWidth: number,
    options: { showMode: boolean; showUsage: boolean; showCost: boolean },
  ): { provider: number; mode: number; bar: number; usage: number; cost: number } {
    const safeWidth = Math.max(5, Math.floor(totalWidth));

    const enabledColumns = [
      { key: "provider" as const, weight: 20 },
      ...(options.showMode ? [{ key: "mode" as const, weight: 10 }] : []),
      { key: "bar" as const, weight: 44 },
      ...(options.showUsage ? [{ key: "usage" as const, weight: 13 }] : []),
      ...(options.showCost ? [{ key: "cost" as const, weight: 13 }] : []),
    ];

    const weightTotal = enabledColumns.reduce((sum, item) => sum + item.weight, 0);
    const cols = { provider: 0, mode: 0, bar: 0, usage: 0, cost: 0 };

    for (const item of enabledColumns) {
      cols[item.key] = Math.max(1, Math.floor((safeWidth * item.weight) / weightTotal));
    }

    const activeOrder = (["bar", "provider", "usage", "cost", "mode"] as const).filter((key) =>
      enabledColumns.some((item) => item.key === key),
    );

    const currentTotal = (): number => cols.provider + cols.mode + cols.bar + cols.usage + cols.cost;
    let diff = safeWidth - currentTotal();

    while (diff > 0) {
      for (const key of activeOrder) {
        if (diff <= 0) {
          break;
        }
        cols[key] += 1;
        diff -= 1;
      }
    }

    while (diff < 0) {
      for (const key of activeOrder) {
        if (diff >= 0) {
          break;
        }
        if (cols[key] > 1) {
          cols[key] -= 1;
          diff += 1;
        }
      }
      if (activeOrder.every((key) => cols[key] <= 1)) {
        break;
      }
    }

    return cols;
  }

  function buildDashboard(theme: ThemeDefinition) {
    const enabled = getEnabledProviderKeys();
    if (enabled.length === 0) {
      return Box(
        {
          flexGrow: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.appBg,
        },
        Text({ content: "No enabled providers. Open settings and enable one.", fg: theme.warning }),
      );
    }

    state.dashboardSelection = clamp(state.dashboardSelection, 0, enabled.length - 1);
    const selectedKey = enabled[state.dashboardSelection] ?? enabled[0] ?? DEFAULT_AGENT;
    const viewportWidth = getViewportWidth();
    const showModeColumn = state.config.showModeColumn ?? true;
    const dashboardMetrics = state.config.dashboardMetrics ?? "both";
    const showUsageColumn = dashboardMetrics !== "cost";
    const showCostColumn = dashboardMetrics !== "req";

    const effectiveDetailMode = resolveEffectiveDetailPaneMode();
    const sideWidth = effectiveDetailMode === "sidebar" ? Math.min(44, Math.max(30, Math.floor(viewportWidth * 0.32))) : 0;
    const SIDE_GAP = 4;

    const availableTableWidth = Math.max(5, viewportWidth - 2 - (effectiveDetailMode === "sidebar" ? sideWidth + SIDE_GAP : 0));

    const decimals = state.config.decimalPlaces ?? 0;
    // build textual previews for computing widest-cell widths
    const rowTexts = enabled.map((k) => {
      const s = state.snapshots[k];
      const u = getUsageParts(k);
      const c = getCostParts(k);
      return {
        provider: s.label,
        mode: s.billingMode === "payg" ? "PAYG" : "QUOTA",
        percent: `${(s.progress * 100).toFixed(decimals)}%`,
        usage: u.used,
        usageMax: u.max,
        cost: c.current,
        costMax: c.max,
      };
    });

    const headerLens = {
      provider: "Provider".length,
      mode: "Mode".length,
      progress: "Progress".length,
      usage: "Used".length,
      usageMax: "Max".length,
      cost: "Cost".length,
      costMax: "Max".length,
    };

    const providerMax = Math.max(headerLens.provider, ...(rowTexts.map((r) => r.provider.length)));
    const modeMax = Math.max(headerLens.mode, ...(rowTexts.map((r) => r.mode.length)));
    const usageMax = Math.max(headerLens.usage, ...(rowTexts.map((r) => r.usage.length)));
    const usageLimitMax = Math.max(headerLens.usageMax, ...(rowTexts.map((r) => r.usageMax.length)));
    const costMax = Math.max(headerLens.cost, ...(rowTexts.map((r) => r.cost.length)));
    const costLimitMax = Math.max(headerLens.costMax, ...(rowTexts.map((r) => r.costMax.length)));

    // calculate max width for % column separately
    const percentColMax = Math.max("%".length, ...rowTexts.map(r => r.percent.length));

    // desired widths = widest content per column (with sensible minimums)
    const MIN = {
      provider: 8,
      mode: 4,
      bar: Math.max(8, Math.floor(availableTableWidth * 0.15)),
      percent: percentColMax,
      usage: 5,
      usageMax: 5,
      cost: 5,
      costMax: 5,
    };

    const desired = {
      provider: Math.max(MIN.provider, providerMax),
      mode: Math.max(MIN.mode, modeMax),
      bar: Math.max(MIN.bar, 20),
      percent: percentColMax,
      usage: Math.max(MIN.usage, usageMax),
      usageMax: Math.max(MIN.usageMax, usageLimitMax),
      cost: Math.max(MIN.cost, costMax),
      costMax: Math.max(MIN.costMax, costLimitMax),
    };

    // include only visible columns when totaling
    let widths = {
      provider: desired.provider,
      mode: showModeColumn ? desired.mode : 0,
      bar: desired.bar,
      percent: desired.percent,
      usage: showUsageColumn ? desired.usage : 0,
      usageMax: showUsageColumn ? desired.usageMax : 0,
      cost: showCostColumn ? desired.cost : 0,
      costMax: showCostColumn ? desired.costMax : 0,
    };

    // spacing between visible table columns (added gap counted in width math)
    const COL_GAP = 2;
    const visibleCols = 2 + (showModeColumn ? 1 : 0) + 1 + (showUsageColumn ? 2 : 0) + (showCostColumn ? 2 : 0);
    const gapCount = Math.max(0, visibleCols - 1);

    const totalWidth = () =>
      widths.provider + widths.mode + widths.bar + widths.percent +
      widths.usage + widths.usageMax + widths.cost + widths.costMax + gapCount * COL_GAP;

    let over = totalWidth() - availableTableWidth;
    const shrinkOrder: Array<keyof typeof widths> = ["provider", "usage", "usageMax", "cost", "costMax", "mode", "bar"];

    while (over > 0) {
      let reduced = false;
      for (const k of shrinkOrder) {
        if (k === "percent" || widths[k] === 0) continue;
        const minForKey = MIN[k as keyof typeof MIN] ?? 1;
        if (widths[k] > minForKey) {
          widths[k] -= 1;
          over -= 1;
          reduced = true;
          if (over <= 0) break;
        }
      }
      if (!reduced) break; // cannot shrink further
    }

    const colProvider = widths.provider;
    const colMode = widths.mode;
    const colBar = Math.max(1, widths.bar);
    const colPercent = widths.percent;
    const colUsage = widths.usage;
    const colUsageMax = widths.usageMax;
    const colCost = widths.cost;
    const colCostMax = widths.costMax;

    const tableWidth = totalWidth();

    const totalContentWidth = effectiveDetailMode === "sidebar" ? (tableWidth + SIDE_GAP + sideWidth) : tableWidth;

    const headerRow = Box(
      { width: tableWidth, flexDirection: "row" },
      Box({ width: colProvider }, Text({ content: fit("Provider", colProvider), fg: theme.success, truncate: true })),
      Box({ width: COL_GAP }),
      ...(showModeColumn ? [Box({ width: colMode }, Text({ content: fit("Mode", colMode), fg: theme.success, truncate: true })), Box({ width: COL_GAP })] : []),
      Box({ width: colBar }, Text({ content: fit("Progress", colBar), fg: theme.success, truncate: true })),
      Box({ width: COL_GAP }),
      Box({ width: colPercent }, Text({ content: fit("%", colPercent), fg: theme.success, truncate: true })),
      ...(showUsageColumn
        ? [
          Box({ width: COL_GAP }),
          Box({ width: colUsage }, Text({ content: fit("Used", colUsage), fg: theme.success, truncate: true })),
          Box({ width: COL_GAP }),
          Box({ width: colUsageMax }, Text({ content: fit("Max", colUsageMax), fg: theme.success, truncate: true })),
        ]
        : []),
      ...(showCostColumn
        ? [
          Box({ width: COL_GAP }),
          Box({ width: colCost }, Text({ content: fit("Cost", colCost), fg: theme.success, truncate: true })),
          Box({ width: COL_GAP }),
          Box({ width: colCostMax }, Text({ content: fit("Max", colCostMax), fg: theme.success, truncate: true })),
        ]
        : []),
    );

    const rows = enabled.map((key, index) => {
      const snapshot = state.snapshots[key];
      const rowSelected = index === state.dashboardSelection;
      const rowColor = rowSelected ? snapshot.accent : theme.muted;
      const mode = snapshot.billingMode === "payg" ? "PAYG" : "QUOTA";

      const decimals = state.config.decimalPlaces ?? 0;
      const percentStr = `${(snapshot.progress * 100).toFixed(decimals)}%`;
      const usage = getUsageParts(key);
      const cost = getCostParts(key);

      // The visual bar now uses the dedicated `colBar` width.
      const barInnerWidth = colBar;
      let progressStr = "";

      if (snapshot.loading) {
        // Wave-style animations from left to right
        const frame = state.animationFrame;
        const style = state.config.barStyle;
        const width = barInnerWidth;

        let anim = "";
        for (let i = 0; i < width; i++) {
          const phase = (frame - i);
          if (style === "braille") {
            const blocks = ["⡀", "⡄", "⡆", "⡇", "⣇", "⣧", "⣷", "⣿", "⣷", "⣧", "⣇", "⡇", "⡆", "⡄"];
            const idx = ((phase % blocks.length) + blocks.length) % blocks.length;
            anim += blocks[idx] || " ";
          } else if (style === "dots") {
            const blocks = ["⠐", "⠠", "⢀", "⡀", "⠄", "⠂", "⠁", "⠈"];
            const idx = ((phase % blocks.length) + blocks.length) % blocks.length;
            anim += blocks[idx] || " ";
          } else if (style === "solid" || style === "shaded") {
            const blocks = ["░", "▒", "▓", "█", "▓", "▒"];
            const idx = ((phase % blocks.length) + blocks.length) % blocks.length;
            anim += blocks[idx] || " ";
          } else {
            const blocks = ["-", "\\", "|", "/"];
            const idx = ((phase % blocks.length) + blocks.length) % blocks.length;
            anim += blocks[idx] || " ";
          }
        }
        progressStr = anim;
      } else {
        const bar = toBar(snapshot.progress, barInnerWidth, state.config.barStyle, decimals);
        progressStr = `${bar.fill}${bar.empty}`;
      }

      return Box(
        {
          width: tableWidth,
          flexDirection: "row",
          backgroundColor: "transparent",
        },
        Box({ width: colProvider },
          Text({ content: fit(snapshot.label, colProvider), fg: rowColor, truncate: true }),
        ),
        Box({ width: COL_GAP }),
        ...(showModeColumn
          ? [
            Box({ width: colMode },
              Text({ content: fit(mode, colMode), fg: rowColor, truncate: true }),
            ),
            Box({ width: COL_GAP }),
          ]
          : []),
        // Visual bar column
        Box({ width: colBar },
          Text({ content: progressStr, fg: rowColor, truncate: true }),
        ),
        Box({ width: COL_GAP }),
        // Percentage column - strictly right-aligned to match the header
        Box({ width: colPercent },
          Text({ content: fit(percentStr, colPercent), fg: rowColor, truncate: true }),
        ),
        ...(showUsageColumn
          ? [
            Box({ width: COL_GAP }),
            Box({ width: colUsage },
              Text({ content: fit(usage.used, colUsage), fg: rowColor, truncate: true }),
            ),
            Box({ width: COL_GAP }),
            Box({ width: colUsageMax },
              Text({ content: fit(usage.max, colUsageMax), fg: rowColor, truncate: true }),
            ),
          ]
          : []),
        ...(showCostColumn
          ? [
            Box({ width: COL_GAP }),
            Box({ width: colCost },
              Text({ content: fit(cost.current, colCost), fg: rowColor, truncate: true }),
            ),
            Box({ width: COL_GAP }),
            Box({ width: colCostMax },
              Text({ content: fit(cost.max, colCostMax), fg: rowColor, truncate: true }),
            ),
          ]
          : []),
      );
    });

    const tableColumn = Box(
      {
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.appBg,
      },
      headerRow,
      ...rows,
    );

    if (effectiveDetailMode === "hidden") {
      return Box(
        {
          flexGrow: 1,
          backgroundColor: theme.appBg,
        },
        tableColumn,
      );
    }

    if (effectiveDetailMode === "bottom") {
      const bottomDetailWidth = tableWidth;

      // render table + details as a compact, centered group so the details sit
      // immediately under the table (not pinned to the window bottom)
      const compactTableBlock = Box(
        {
          width: "100%",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.appBg,
        },
        headerRow,
        ...rows,
      );

      const modelSpan = colProvider + COL_GAP + (showModeColumn ? colMode + COL_GAP : 0) + colBar;
      const reqSpan = showUsageColumn ? colUsage : Math.max(8, Math.floor(tableWidth * 0.16));

      return Box(
        {
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: theme.appBg,
          paddingLeft: 1,
          paddingRight: 1,
          alignItems: "center",
          justifyContent: "center",
        },
        buildHeader(theme, totalContentWidth),
        Box({ height: 1 }),
        compactTableBlock,
        Box(
          {
            width: "100%",
            alignItems: "center",
            paddingTop: 1,
          },
          buildDetailPane(
            theme,
            selectedKey,
            bottomDetailWidth,
            {
              modelPct: colProvider / tableWidth,
              reqPct: showUsageColumn ? colUsage / tableWidth : 0,
              costPct: showCostColumn ? colCost / tableWidth : 0,
            },
            showUsageColumn,
            showCostColumn,
          ),
        ),
        Box({ height: 1 }),
        buildCommandBar(theme, totalContentWidth),
      );
    }

    return Box(
      {
        flexGrow: 1,
        flexDirection: "column",
        backgroundColor: theme.appBg,
        alignItems: "center",
        justifyContent: "center",
      },
      buildHeader(theme, totalContentWidth),
      Box({ height: 1 }),
      Box(
        {
          flexDirection: "row",
          alignItems: "flex-start",
        },
        Box(
          {
            flexDirection: "column",
            alignItems: "center",
          },
          headerRow,
          ...rows,
        ),
        Box({ width: SIDE_GAP }),
        buildDetailPane(theme, selectedKey, sideWidth, undefined, showUsageColumn, showCostColumn),
      ),
      Box({ height: 1 }),
      buildCommandBar(theme, totalContentWidth),
    );
  }

  function getModelRows(): ModelRow[] {
    const rows: ModelRow[] = [];

    for (const providerKey of providerOrder) {
      rows.push({ kind: "provider", providerKey });
      if (state.expandedProviders[providerKey]) {
        rows.push({ kind: "field", providerKey, field: "enabled" });
        rows.push({ kind: "field", providerKey, field: "billingMode" });
        rows.push({ kind: "field", providerKey, field: "credential" });
        rows.push({ kind: "field", providerKey, field: "accentColor" });
        rows.push({ kind: "field", providerKey, field: "username" });
        rows.push({ kind: "field", providerKey, field: "monthlyLimit" });
        rows.push({ kind: "field", providerKey, field: "costLimit" });
        rows.push({ kind: "field", providerKey, field: "manualUsed" });
        rows.push({ kind: "field", providerKey, field: "manualCost" });
      }
    }

    return rows;
  }

  function modelControl(providerKey: AgentKey, field: ModelFieldKey): string {
    const cfg = state.config.agents[providerKey];
    const provider = getProvider(providerKey);

    switch (field) {
      case "enabled":
        return cfg.enabled ? "On" : "Off";
      case "billingMode":
        const bm = cfg.billingMode.charAt(0).toUpperCase() + cfg.billingMode.slice(1);
        return `◀ ${bm} ▶`;
      case "credential":
        return provider.isConfigured(cfg) ? "Configured" : "Edit";
      case "accentColor":
        return cfg.accentColor?.trim() ? cfg.accentColor : provider.accent;
      case "username":
        return cfg.username?.trim() ? cfg.username : "Unset";
      case "monthlyLimit":
        return `◀ ${typeof cfg.monthlyLimit === "number" ? formatNumber(cfg.monthlyLimit) : "None"} ▶`;
      case "costLimit":
        return `◀ ${typeof cfg.costLimit === "number" ? formatMoney(cfg.costLimit) : "None"} ▶`;
      case "manualUsed":
        return `◀ ${typeof cfg.manualUsed === "number" ? formatNumber(cfg.manualUsed) : "0"} ▶`;
      case "manualCost":
        return `◀ ${typeof cfg.manualCost === "number" ? formatMoney(cfg.manualCost) : "$0"} ▶`;
      default:
        return "";
    }
  }

  function modelFieldTitle(field: ModelFieldKey): string {
    switch (field) {
      case "enabled":
        return "Enabled";
      case "billingMode":
        return "Billing Mode";
      case "credential":
        return "Credential";
      case "accentColor":
        return "Provider Color";
      case "username":
        return "Username";
      case "monthlyLimit":
        return "Monthly Limit";
      case "costLimit":
        return "Cost Limit";
      case "manualUsed":
        return "Manual Usage";
      case "manualCost":
        return "Manual Cost";
      default:
        return "";
    }
  }

  function formatControl(value: string, width: number): string {
    // width -> total width including surrounding brackets; inner content area = width - 4
    const innerWidth = Math.max(0, width - 4);

    // detect arrow-wrapped pattern (e.g. "◀ value ▶") and treat arrows as corner glyphs
    const arrowMatch = value.match(/^\s*◀\s*(.*?)\s*▶\s*$/);
    const hasArrows = Boolean(arrowMatch);
    const core = arrowMatch?.[1] ?? value;

    let trimmed = core;
    if (trimmed.length > innerWidth) {
      trimmed = trimmed.slice(0, innerWidth - 1) + "…";
    }

    const leftPad = Math.floor((innerWidth - trimmed.length) / 2);
    const rightPad = innerWidth - trimmed.length - leftPad;
    const content = " ".repeat(leftPad) + trimmed + " ".repeat(rightPad);

    if (hasArrows) {
      // place arrows immediately inside the brackets: "[◀<content>▶]"
      return "[" + "◀" + content + "▶" + "]";
    }

    // default: keep a single-space gutter inside brackets
    return `[ ${content} ]`;
  }

  // backward-compatible helper (keeps old behavior when width is unknown)
  function asControl(value: string): string {
    return `[ ${value} ]`;
  }

  function settingsColumnWidths(contentWidth: number): { titleWidth: number; descriptionWidth: number; controlWidth: number } {
    const controlWidth = clamp(Math.floor(contentWidth * 0.30), 20, 28);
    const titleWidth = clamp(Math.floor(contentWidth * 0.24), 14, 24);
    const descriptionWidth = Math.max(12, contentWidth - titleWidth - controlWidth);
    return { titleWidth, descriptionWidth, controlWidth };
  }

  function buildModelSettingsPanel(theme: ThemeDefinition, contentWidth: number) {
    const rows = getModelRows();
    if (rows.length === 0) {
      return Box({}, Text({ content: "No providers found.", fg: theme.warning }));
    }

    state.modelSelection = clamp(state.modelSelection, 0, rows.length - 1);

    const { titleWidth, descriptionWidth, controlWidth } = settingsColumnWidths(contentWidth);

    const header = Box(
      {
        width: "100%",
        flexDirection: "row",
      },
      Text({ content: fit("Setting", titleWidth), fg: theme.success, truncate: true }),
      Text({ content: fit("Description", descriptionWidth), fg: theme.success, truncate: true }),
      Text({ content: fit("Control", controlWidth), fg: theme.success, truncate: true }),
    );

    const rendered = rows.map((row, index) => {
      const selected = !state.settingsNavFocused && state.settingsPage === "model-settings" && state.modelSelection === index;

      if (row.kind === "provider") {
        const expanded = state.expandedProviders[row.providerKey];
        const snapshot = state.snapshots[row.providerKey];
        const control = formatControl(`${snapshot.enabled ? "On" : "Off"} • ${expanded ? "Open" : "Closed"}`, controlWidth);

        return Box(
          {
            width: "100%",
            flexDirection: "row",
            backgroundColor: selected ? theme.selectionBg : "transparent",
          },
          Text({
            content: fit(`${expanded ? "▾" : "▸"} ${snapshot.label}`, titleWidth),
            fg: selected ? theme.selectionText : theme.success,
            truncate: true,
          }),
          Text({
            content: fit("Provider section", descriptionWidth),
            fg: selected ? theme.selectionText : theme.muted,
            truncate: true,
          }),
          Text({
            content: fit(control, controlWidth),
            fg: selected ? theme.selectionText : theme.success,
            truncate: true,
          }),
        );
      }

      const control = formatControl(modelControl(row.providerKey, row.field), controlWidth);

      return Box(
        {
          width: "100%",
          flexDirection: "row",
          backgroundColor: selected ? theme.selectionBg : "transparent",
        },
        Text({
          content: fit(`  ${modelFieldTitle(row.field)}`, titleWidth),
          fg: selected ? theme.selectionText : theme.text,
          truncate: true,
        }),
        Text({
          content: fit(fieldDescription(row.field), descriptionWidth),
          fg: selected ? theme.selectionText : theme.muted,
          truncate: true,
        }),
        Text({
          content: fit(control, controlWidth),
          fg: selected ? theme.selectionText : theme.success,
          truncate: true,
        }),
      );
    });

    return Box(
      {
        width: "100%",
        flexDirection: "column",
        backgroundColor: theme.appBg,
      },
      header,
      ...rendered,
    );
  }

  function buildUiSettingsPanel(theme: ThemeDefinition, contentWidth: number) {
    const rows: UiRowKey[] = [
      "theme",
      "barStyle",
      "refreshSeconds",
      "detailPaneMode",
      "dashboardMetrics",
      "showModeColumn",
      "heatmapScope",
      "heatmapProvider",
      "heatmapMetric",
      "heatmapChars",
      "heatmapCellWidth",
      "heatmapInfoMode",
      "heatmapPaletteSteps",
      "heatmapMaxDays",
      "decimalPlaces",
    ];
    state.uiSelection = clamp(state.uiSelection, 0, rows.length - 1);

    const { titleWidth, descriptionWidth, controlWidth } = settingsColumnWidths(contentWidth);

    const header = Box(
      {
        width: "100%",
        flexDirection: "row",
      },
      Text({ content: fit("Setting", titleWidth), fg: theme.success, truncate: true }),
      Text({ content: fit("Description", descriptionWidth), fg: theme.success, truncate: true }),
      Text({ content: fit("Control", controlWidth), fg: theme.success, truncate: true }),
    );

    const rendered = rows.map((row, index) => {
      const selected = !state.settingsNavFocused && state.settingsPage === "ui-settings" && state.uiSelection === index;

      let title = "";
      let description = "";
      let value = "";

      if (row === "theme") {
        title = "Theme";
        description = "Preview and apply app palette";
        value = formatControl(`◀ ${getThemeSafe().label} ▶`, controlWidth);
      }

      if (row === "barStyle") {
        title = "Usage bars";
        description = "Progress visual style";
        value = formatControl(`◀ ${state.config.barStyle} ▶`, controlWidth);
      }

      if (row === "refreshSeconds") {
        title = "Refresh";
        description = "Automatic refresh interval";
        value = formatControl(`◀ ${formatRefresh(state.config.refreshSeconds)} ▶`, controlWidth);
      }

      if (row === "detailPaneMode") {
        title = "Detail pane";
        description = "Sidebar, bottom, or hidden";
        const dp = state.config.detailPaneMode ?? "sidebar";
        value = formatControl(`◀ ${dp} ▶`, controlWidth);
      }

      if (row === "dashboardMetrics") {
        title = "Dashboard metric";
        description = "Show req, cost, or both columns";
        value = formatControl(`◀ ${(state.config.dashboardMetrics ?? "both").toUpperCase()} ▶`, controlWidth);
      }

      if (row === "showModeColumn") {
        title = "Mode column";
        description = "Toggle Mode column visibility";
        value = formatControl(`◀ ${(state.config.showModeColumn ?? true) ? "ON" : "OFF"} ▶`, controlWidth);
      }

      if (row === "heatmapScope") {
        title = "Heatmap source";
        description = "Focused provider, selected provider, or total";
        value = formatControl(`◀ ${(state.config.heatmapScope ?? "focused").toUpperCase()} ▶`, controlWidth);
      }

      if (row === "heatmapProvider") {
        title = "Heatmap provider";
        description = "Pick provider (cycle or enter key manually)";
        const pk = state.config.heatmapProvider ?? DEFAULT_AGENT;
        const providerKey = (pk === ("all" as any) ? DEFAULT_AGENT : pk) as AgentKey;
        const providerLabel = getProvider(providerKey).label;
        value = formatControl(`◀ ${providerLabel} ▶`, controlWidth);
      }

      if (row === "heatmapMetric") {
        title = "Heatmap metric";
        description = "Daily graph tracks requests or cost";
        value = formatControl(`◀ ${(state.config.heatmapMetric ?? "req").toUpperCase()} ▶`, controlWidth);
      }

      if (row === "heatmapChars") {
        title = "Heatmap glyph";
        description = "Single character used to draw graph cells";
        value = formatControl(state.config.heatmapChars ?? "⣿", controlWidth);
      }

      if (row === "heatmapCellWidth") {
        title = "Cell width";
        description = "Repeat the glyph (1-4 characters wide)";
        value = formatControl(`◀ ${state.config.heatmapCellWidth ?? 1} ▶`, controlWidth);
      }

      if (row === "heatmapInfoMode") {
        title = "Heatmap labels";
        description = "Show days, week, year, all, or none";
        value = formatControl(`◀ ${(state.config.heatmapInfoMode ?? "days").toUpperCase()} ▶`, controlWidth);
      }

      if (row === "heatmapPaletteSteps") {
        title = "Heatmap colors";
        description = "Number of color levels in legend";
        value = formatControl(`◀ ${state.config.heatmapPaletteSteps ?? 7} ▶`, controlWidth);
      }

      if (row === "heatmapMaxDays") {
        title = "Heatmap max days";
        description = "Cap history length (graph width follows)";
        value = formatControl(`◀ ${state.config.heatmapMaxDays ?? 364} ▶`, controlWidth);
      }

      if (row === "decimalPlaces") {
        title = "Decimal places";
        description = "Number of decimals in progress %";
        value = formatControl(`◀ ${state.config.decimalPlaces ?? 0} ▶`, controlWidth);
      }

      return Box(
        {
          width: "100%",
          flexDirection: "row",
          backgroundColor: selected ? theme.selectionBg : "transparent",
        },
        Text({ content: fit(title, titleWidth), fg: selected ? theme.selectionText : theme.text, truncate: true }),
        Text({ content: fit(description, descriptionWidth), fg: selected ? theme.selectionText : theme.muted, truncate: true }),
        Text({ content: fit(value, controlWidth), fg: selected ? theme.selectionText : theme.success, truncate: true }),
      );
    });

    return Box(
      {
        width: "100%",
        flexDirection: "column",
        backgroundColor: theme.appBg,
      },
      header,
      ...rendered,
    );
  }

  function buildSettings(theme: ThemeDefinition) {
    const viewportWidth = getViewportWidth();
    const navWidth = clamp(Math.floor(viewportWidth * 0.24), 14, 24);
    const contentWidth = Math.max(10, viewportWidth - navWidth - 4);

    const navRows = SETTINGS_PAGES.map((page, index) => {
      const selected = SETTINGS_PAGES.findIndex((item) => item.key === state.settingsPage) === index;
      const focused = selected && state.settingsNavFocused;

      return Box(
        {
          width: "100%",
          backgroundColor: focused ? theme.selectionBg : "transparent",
        },
        Text({
          content: `${selected ? "▸" : " "} ${page.label}`,
          fg: focused ? theme.selectionText : selected ? theme.success : theme.text,
          truncate: true,
        }),
      );
    });

    const rightPanel =
      state.settingsPage === "model-settings" ? buildModelSettingsPanel(theme, contentWidth) : buildUiSettingsPanel(theme, contentWidth);

    return Box(
      {
        flexGrow: 1,
        flexDirection: "row",
        backgroundColor: theme.appBg,
        paddingTop: 1,
      },
      Box(
        {
          width: navWidth,
          backgroundColor: theme.appBg,
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: "column",
        },
        Text({ content: "Settings", fg: theme.success, truncate: true }),
        ...navRows,
      ),
      Box(
        {
          flexGrow: 1,
          width: contentWidth,
          backgroundColor: theme.appBg,
          paddingLeft: 1,
          paddingRight: 1,
        },
        rightPanel,
      ),
    );
  }

  function buildOverlay() {
    return Box({
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      backgroundColor: "#000000",
      opacity: 0.65,
    });
  }

  function buildPromptPopup(theme: ThemeDefinition) {
    const prompt = state.prompt;
    if (!prompt) {
      return Box({ width: 1, height: 1 });
    }

    const popupWidth = Math.max(58, Math.min(96, renderer.width - 8));
    const popupHeight = Math.min(renderer.height - 4, 7 + prompt.instructions.length);

    return Box(
      {
        position: "absolute",
        left: Math.max(2, Math.floor((renderer.width - popupWidth) / 2)),
        top: Math.max(2, Math.floor((renderer.height - popupHeight) / 2)),
        width: popupWidth,
        height: popupHeight,
        borderStyle: "rounded",
        borderColor: theme.success,
        title: ` ${prompt.title} `,
        titleAlignment: "center",
        backgroundColor: theme.appBg,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
      },
      ...prompt.instructions.map((line) => Text({ content: line, fg: theme.muted, truncate: true })),
      Text({ content: "", fg: theme.text }),
      Text({ content: `> ${prompt.secret ? "*".repeat(prompt.value.length) : prompt.value}${state.promptCursorVisible ? "█" : " "}`, fg: theme.text, truncate: true }),
    );
  }

  function buildThemePopup(theme: ThemeDefinition) {
    const popupWidth = Math.max(44, Math.min(68, renderer.width - 8));
    const popupHeight = Math.min(renderer.height - 4, THEMES.length + 4);
    const start = clamp(state.themePopupSelection - Math.floor((popupHeight - 3) / 2), 0, Math.max(0, THEMES.length - (popupHeight - 3)));
    const visible = THEMES.slice(start, start + popupHeight - 3);

    return Box(
      {
        position: "absolute",
        left: Math.max(2, Math.floor((renderer.width - popupWidth) / 2)),
        top: Math.max(1, Math.floor((renderer.height - popupHeight) / 2)),
        width: popupWidth,
        height: popupHeight,
        borderStyle: "rounded",
        borderColor: theme.success,
        title: " Theme ",
        titleAlignment: "center",
        backgroundColor: theme.appBg,
        paddingTop: 1,
      },
      ...visible.map((item, offset) => {
        const index = start + offset;
        const selected = index === state.themePopupSelection;

        return Box(
          {
            width: "100%",
            backgroundColor: selected ? theme.selectionBg : "transparent",
            paddingLeft: 1,
            paddingRight: 1,
          },
          Text({ content: `${selected ? "▶" : " "} ${item.label}`, fg: selected ? theme.selectionText : theme.text, truncate: true }),
        );
      }),
    );
  }

  function redraw(): void {
    const theme = getThemeSafe();
    const viewportWidth = getViewportWidth();
    const viewportHeight = getViewportHeight();
    const viewportLeft = getViewportLeft();

    const old = renderer.root.getRenderable("app-root");
    if (old) {
      renderer.root.remove("app-root");
    }

    const frameChildren = state.screen === "dashboard"
      ? [buildDashboard(theme)]
      : [buildHeader(theme), buildSettings(theme), buildCommandBar(theme)];

    const rootChildren = [
      Box(
        {
          id: "app-frame",
          position: "absolute",
          left: viewportLeft,
          top: APP_PAD_Y,
          width: viewportWidth,
          height: viewportHeight,
          backgroundColor: theme.appBg,
          flexDirection: "column",
        },
        ...frameChildren,
      ),
    ];

    if (state.prompt || state.themePopupOpen) {
      rootChildren.push(buildOverlay());

      if (state.themePopupOpen) {
        rootChildren.push(buildThemePopup(theme));
      }

      if (state.prompt) {
        rootChildren.push(buildPromptPopup(theme));
      }
    }

    renderer.root.add(
      Box(
        {
          id: "app-root",
          width: "100%",
          height: "100%",
          backgroundColor: theme.appBg,
          flexDirection: "column",
          padding: 0,
        },
        ...rootChildren,
      ),
    );
  }

  function handleTerminalResize(): void {
    redraw();
  }

  function startResizeWatcher(): void {
    if (state.resizeWatchTimer) {
      clearInterval(state.resizeWatchTimer);
      state.resizeWatchTimer = null;
    }

    let lastWidth = renderer.width;
    let lastHeight = renderer.height;

    state.resizeWatchTimer = setInterval(() => {
      if (state.shuttingDown) {
        return;
      }

      if (renderer.width !== lastWidth || renderer.height !== lastHeight) {
        lastWidth = renderer.width;
        lastHeight = renderer.height;
        redraw();
      }
    }, 120);
  }

  function restartAutoRefresh(): void {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }

    state.refreshTimer = setInterval(() => {
      void refreshUsage("timer");
    }, state.config.refreshSeconds * 1000);
  }

  async function refreshUsage(reason: string): Promise<void> {
    if (state.refreshing) {
      return;
    }

    state.refreshing = true;
    state.statusLine = `refresh ${reason}`;
    redraw();

    await Promise.all(
      PROVIDERS.map(async (provider) => {
        const cfg = state.config.agents[provider.key];
        const snapshot = state.snapshots[provider.key];

        snapshot.enabled = cfg.enabled;
        snapshot.billingMode = cfg.billingMode;
        snapshot.configured = provider.isConfigured(cfg);
        snapshot.accent = cfg.accentColor?.trim() || provider.accent;
        snapshot.label = provider.label;

        if (!cfg.enabled) {
          snapshot.loading = false;
          snapshot.error = undefined;
          snapshot.used = 0;
          snapshot.limit = cfg.billingMode === "quota" ? cfg.monthlyLimit : undefined;
          snapshot.cost = 0;
          snapshot.progress = 0;
          snapshot.breakdown = [];
          snapshot.daily = normalizeDailyUsage(undefined);
          snapshot.details = ["disabled"];
          return;
        }

        if (!snapshot.configured) {
          snapshot.loading = false;
          snapshot.error = undefined;
          snapshot.used = 0;
          snapshot.limit = cfg.billingMode === "quota" ? cfg.monthlyLimit : undefined;
          snapshot.cost = 0;
          snapshot.progress = 0;
          snapshot.breakdown = [];
          snapshot.daily = normalizeDailyUsage(undefined);
          snapshot.details = ["missing credentials"];
          return;
        }

        try {
          snapshot.loading = true;
          snapshot.fetchedMonths = 0;
          snapshot.revealCursor = 0;
          const usage = await provider.fetchUsage(cfg, (partial) => {
            if (partial.used !== undefined) snapshot.used = partial.used;
            if (partial.cost !== undefined) snapshot.cost = partial.cost;
            if (partial.breakdown !== undefined) snapshot.breakdown = partial.breakdown;
            if (partial.daily !== undefined) snapshot.daily = normalizeDailyUsage(partial.daily);
            if (partial.fetchedMonths !== undefined) snapshot.fetchedMonths = partial.fetchedMonths;
            if (partial.limit !== undefined) {
              snapshot.limit = partial.limit;
              snapshot.progress = pickConfiguredProgress(cfg.billingMode, snapshot.used, partial.limit);
            } else {
              snapshot.progress = pickConfiguredProgress(cfg.billingMode, snapshot.used, snapshot.limit);
            }
            redraw();
          });
          const limit = cfg.billingMode === "quota" ? usage.limit ?? cfg.monthlyLimit : undefined;

          snapshot.loading = false;
          snapshot.error = undefined;
          snapshot.used = usage.used;
          snapshot.limit = limit;
          snapshot.unit = usage.unit;
          snapshot.cost = usage.cost ?? 0;
          snapshot.progress = pickConfiguredProgress(cfg.billingMode, usage.used, limit);
          snapshot.breakdown = usage.breakdown ?? [];
          snapshot.daily = normalizeDailyUsage(usage.daily);
          snapshot.fetchedMonths = usage.fetchedMonths;
          snapshot.details = usage.details;
          snapshot.fetchedAt = formatClock(new Date());
        } catch (error) {
          snapshot.loading = false;
          snapshot.error = error instanceof Error ? error.message : String(error);
          snapshot.progress = 0;
          snapshot.breakdown = [];
          snapshot.daily = normalizeDailyUsage(undefined);
          snapshot.details = ["fetch failed"];
        }
      }),
    );

    state.refreshing = false;
    state.lastUpdatedAt = formatClock(new Date());
    state.statusLine = "updated";
    redraw();
  }

  function shutdown(): void {
    if (state.shuttingDown) {
      return;
    }

    state.shuttingDown = true;

    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }

    if (state.promptCursorTimer) {
      clearInterval(state.promptCursorTimer);
      state.promptCursorTimer = null;
    }

    if (state.resizeWatchTimer) {
      clearInterval(state.resizeWatchTimer);
      state.resizeWatchTimer = null;
    }

    if (process.stdout.isTTY) {
      process.stdout.removeListener("resize", handleTerminalResize);
    }

    try {
      renderer.destroy();
    } finally {
      process.exit(0);
    }
  }

  function handlePromptPaste(text: string): void {
    if (!state.prompt) {
      return;
    }

    // show caret immediately on paste
    state.promptCursorVisible = true;

    const clean = text.replace(/\r/g, "").replace(/\n/g, "");
    if (!clean) {
      return;
    }

    if (state.prompt.mode === "number") {
      const numeric = clean.replace(/[^0-9.]/g, "");
      if (!numeric) {
        return;
      }
      state.prompt.value += numeric;
      redraw();
      return;
    }

    state.prompt.value += clean;
    redraw();
  }

  function handlePromptKey(key: KeyEvent): void {
    const prompt = state.prompt;
    if (!prompt) {
      return;
    }

    // show caret immediately on any keypress
    state.promptCursorVisible = true;

    const name = key.name.toLowerCase();

    if (name === "escape") {
      closePrompt();
      return;
    }

    if (name === "enter" || name === "return") {
      prompt.onSubmit(prompt.value);
      return;
    }

    if (name === "backspace") {
      if (key.ctrl) {
        const withoutTrailingSpaces = prompt.value.replace(/\s+$/, "");
        prompt.value = withoutTrailingSpaces.replace(/\S+$/, "");
        redraw();
        return;
      }

      prompt.value = prompt.value.slice(0, -1);
      redraw();
      return;
    }

    if (key.ctrl && name === "w") {
      const withoutTrailingSpaces = prompt.value.replace(/\s+$/, "");
      prompt.value = withoutTrailingSpaces.replace(/\S+$/, "");
      redraw();
      return;
    }

    if (key.ctrl && name === "u") {
      prompt.value = "";
      redraw();
      return;
    }

    if (name === "space") {
      prompt.value += " ";
      redraw();
      return;
    }

    if (!key.ctrl && !key.meta && !key.option) {
      const typed = key.sequence.length === 1 && key.sequence >= " " ? key.sequence : key.name.length === 1 ? (key.shift ? key.name.toUpperCase() : key.name) : "";
      if (!typed) {
        return;
      }

      if (prompt.mode === "number" && !/[0-9.]/.test(typed)) {
        return;
      }

      prompt.value += typed;
      redraw();
    }
  }

  function handleThemePopupKey(key: KeyEvent): void {
    if (!state.themePopupOpen) {
      return;
    }

    const name = key.name.toLowerCase();

    const applyThemePreview = (): void => {
      const selected = THEMES[state.themePopupSelection] ?? THEMES[0];
      if (!selected) {
        return;
      }

      state.config.theme = selected.key;
      redraw();
    };

    if (name === "escape") {
      if (state.themePopupPreviousTheme) {
        state.config.theme = state.themePopupPreviousTheme;
      }
      state.themePopupOpen = false;
      state.themePopupPreviousTheme = null;
      state.statusLine = "theme preview canceled";
      redraw();
      return;
    }

    if (name === "up" || name === "k" || name === "left" || name === "a") {
      state.themePopupSelection = cycleIndex(THEMES.length, state.themePopupSelection, -1);
      applyThemePreview();
      return;
    }

    if (name === "down" || name === "j" || name === "right" || name === "d") {
      state.themePopupSelection = cycleIndex(THEMES.length, state.themePopupSelection, 1);
      applyThemePreview();
      return;
    }

    if (name === "enter" || name === "return") {
      const selected = THEMES[state.themePopupSelection] ?? THEMES[0];
      if (selected) {
        state.config.theme = selected.key;
        save();
      }
      state.themePopupOpen = false;
      state.themePopupPreviousTheme = null;
      state.statusLine = "theme updated";
      redraw();
    }
  }

  function changeRefreshPreset(direction: 1 | -1): void {
    const idx = Math.max(0, REFRESH_PRESETS.findIndex((item) => item.seconds === state.config.refreshSeconds));
    const next = REFRESH_PRESETS[cycleIndex(REFRESH_PRESETS.length, idx, direction)];
    if (!next) {
      return;
    }

    state.config.refreshSeconds = next.seconds;
    save();
    restartAutoRefresh();
    redraw();
  }

  function changeBarStyle(direction: 1 | -1): void {
    const idx = Math.max(0, BAR_STYLE_OPTIONS.findIndex((style) => style === state.config.barStyle));
    const next = BAR_STYLE_OPTIONS[cycleIndex(BAR_STYLE_OPTIONS.length, idx, direction)];
    if (!next) {
      return;
    }

    state.config.barStyle = next;
    save();
    redraw();
  }

  function changeDetailPaneMode(direction: 1 | -1): void {
    const order: DetailPaneMode[] = ["sidebar", "bottom", "hidden"];
    const idx = Math.max(0, order.findIndex((mode) => mode === state.config.detailPaneMode));
    const next = order[cycleIndex(order.length, idx, direction)];
    if (!next) {
      return;
    }

    state.config.detailPaneMode = next;
    save();
    redraw();
  }

  function changeDashboardMetrics(direction: 1 | -1): void {
    const order: Array<"both" | "req" | "cost"> = ["both", "req", "cost"];
    const current = state.config.dashboardMetrics ?? "both";
    const idx = Math.max(0, order.findIndex((item) => item === current));
    const next = order[cycleIndex(order.length, idx, direction)];
    if (!next) {
      return;
    }

    state.config.dashboardMetrics = next;
    save();
    redraw();
  }

  function toggleShowModeColumn(): void {
    state.config.showModeColumn = !(state.config.showModeColumn ?? true);
    save();
    redraw();
  }

  function changeHeatmapScope(direction: 1 | -1): void {
    const order: HeatmapScope[] = ["focused", "provider", "total"];
    const current = state.config.heatmapScope ?? "focused";
    const idx = Math.max(0, order.findIndex((item) => item === current));
    const next = order[cycleIndex(order.length, idx, direction)];
    if (!next) {
      return;
    }

    state.config.heatmapScope = next;
    save();
    redraw();
  }

  function changeHeatmapProvider(direction: 1 | -1): void {
    const list: Array<AgentKey> = [...providerOrder];
    const current = state.config.heatmapProvider ?? DEFAULT_AGENT;
    // ensure current is a valid AgentKey (not 'all' from old config)
    const safeCurrent = (current === ("all" as any)) ? DEFAULT_AGENT : current;
    const idx = Math.max(0, list.findIndex((item) => item === safeCurrent));
    const next = list[cycleIndex(list.length, idx, direction)];
    if (!next) {
      return;
    }

    state.config.heatmapProvider = next;
    save();
    redraw();
  }

  function changeHeatmapMetric(direction: 1 | -1): void {
    const order: Array<"req" | "cost"> = ["req", "cost"];
    const current = state.config.heatmapMetric ?? "req";
    const idx = Math.max(0, order.findIndex((item) => item === current));
    const next = order[cycleIndex(order.length, idx, direction)];
    if (!next) {
      return;
    }

    state.config.heatmapMetric = next;
    save();
    redraw();
  }

  function changeHeatmapInfoMode(direction: 1 | -1): void {
    const order: HeatmapInfoMode[] = ["none", "days", "week", "year", "all"];
    const current = state.config.heatmapInfoMode ?? "days";
    const idx = Math.max(0, order.findIndex((item) => item === current));
    const next = order[cycleIndex(order.length, idx, direction)];
    if (!next) {
      return;
    }

    state.config.heatmapInfoMode = next;
    save();
    redraw();
  }

  function changeHeatmapPaletteSteps(direction: 1 | -1): void {
    const current = state.config.heatmapPaletteSteps ?? 7;
    state.config.heatmapPaletteSteps = clamp(current + direction, 2, 9);
    save();
    redraw();
  }

  function changeHeatmapCellWidth(direction: 1 | -1): void {
    const current = state.config.heatmapCellWidth ?? 1;
    state.config.heatmapCellWidth = clamp(current + direction, 1, 4);
    save();
    redraw();
  }

  function changeHeatmapMaxDays(direction: 1 | -1): void {
    const current = state.config.heatmapMaxDays ?? 364;
    const step = 7;
    state.config.heatmapMaxDays = clamp(current + direction * step, 7, 364);
    save();
    redraw();
  }

  function changeDecimalPlaces(direction: 1 | -1): void {
    const current = state.config.decimalPlaces ?? 0;
    state.config.decimalPlaces = clamp(current + direction, 0, 4);
    save();
    redraw();
  }

  function toggleBillingMode(providerKey: AgentKey): void {
    state.config.agents[providerKey].billingMode = state.config.agents[providerKey].billingMode === "quota" ? "payg" : "quota";
    save();
    void refreshUsage("billing mode");
  }

  function stepNumeric(providerKey: AgentKey, field: Extract<ModelFieldKey, "monthlyLimit" | "costLimit" | "manualUsed" | "manualCost">, direction: 1 | -1): void {
    const cfg = state.config.agents[providerKey];
    const stepMap = {
      monthlyLimit: 10,
      costLimit: 1,
      manualUsed: 1,
      manualCost: 0.1,
    } as const;

    const step = stepMap[field];
    const current = cfg[field] ?? 0;
    const next = Math.max(0, current + step * direction);

    if (next === 0 && direction < 0) {
      cfg[field] = undefined;
    } else {
      cfg[field] = Number(next.toFixed(2));
    }

    save();
    void refreshUsage("numeric change");
  }

  function handleModelFieldAction(row: FieldRow, keyName: string): void {
    const cfg = state.config.agents[row.providerKey];

    if (row.field === "enabled" && ["enter", "return", "space", "left", "right"].includes(keyName)) {
      cfg.enabled = !cfg.enabled;
      save();
      void refreshUsage("enabled");
      return;
    }

    if (row.field === "billingMode" && ["enter", "return", "left", "right", "a", "d"].includes(keyName)) {
      toggleBillingMode(row.providerKey);
      return;
    }

    if (row.field === "credential" && ["enter", "return", "e"].includes(keyName)) {
      openCredentialPrompt(row.providerKey);
      return;
    }

    if (row.field === "accentColor" && ["enter", "return", "e"].includes(keyName)) {
      openTextPrompt(
        row.providerKey,
        cfg.accentColor,
        ["Set provider color (hex, e.g. #58a6ff)", "Leave empty to restore default provider color"],
        (next) => {
          cfg.accentColor = next;
        },
      );
      return;
    }

    if (row.field === "username" && ["enter", "return", "e"].includes(keyName)) {
      openTextPrompt(
        row.providerKey,
        cfg.username,
        ["Set username/handle for this provider", "For organization endpoint, use org:YOUR_ORG_SLUG"],
        (next) => {
          cfg.username = next;
        },
      );
      return;
    }

    if (row.field === "monthlyLimit") {
      if (keyName === "left" || keyName === "a") {
        stepNumeric(row.providerKey, "monthlyLimit", -1);
        return;
      }
      if (keyName === "right" || keyName === "d") {
        stepNumeric(row.providerKey, "monthlyLimit", 1);
        return;
      }
      if (["enter", "return", "e"].includes(keyName)) {
        openNumberPrompt(row.providerKey, cfg.monthlyLimit, ["Set max monthly usage (requests)", "Leave empty to clear"], (next) => {
          cfg.monthlyLimit = next;
        });
      }
      return;
    }

    if (row.field === "costLimit") {
      if (keyName === "left" || keyName === "a") {
        stepNumeric(row.providerKey, "costLimit", -1);
        return;
      }
      if (keyName === "right" || keyName === "d") {
        stepNumeric(row.providerKey, "costLimit", 1);
        return;
      }
      if (["enter", "return", "e"].includes(keyName)) {
        openNumberPrompt(row.providerKey, cfg.costLimit, ["Set max monthly cost budget", "Leave empty to clear"], (next) => {
          cfg.costLimit = next;
        });
      }
      return;
    }

    if (row.field === "manualUsed") {
      if (keyName === "left" || keyName === "a") {
        stepNumeric(row.providerKey, "manualUsed", -1);
        return;
      }
      if (keyName === "right" || keyName === "d") {
        stepNumeric(row.providerKey, "manualUsed", 1);
        return;
      }
      if (["enter", "return", "e"].includes(keyName)) {
        openNumberPrompt(row.providerKey, cfg.manualUsed, ["Fallback usage if provider has no live API"], (next) => {
          cfg.manualUsed = next;
        });
      }
      return;
    }

    if (row.field === "manualCost") {
      if (keyName === "left" || keyName === "a") {
        stepNumeric(row.providerKey, "manualCost", -1);
        return;
      }
      if (keyName === "right" || keyName === "d") {
        stepNumeric(row.providerKey, "manualCost", 1);
        return;
      }
      if (["enter", "return", "e"].includes(keyName)) {
        openNumberPrompt(row.providerKey, cfg.manualCost, ["Fallback cost if provider has no live API"], (next) => {
          cfg.manualCost = next;
        });
      }
    }
  }

  function handleModelSettingsKeys(keyName: string): void {
    const rows = getModelRows();
    if (rows.length === 0) {
      return;
    }

    state.modelSelection = clamp(state.modelSelection, 0, rows.length - 1);

    if (keyName === "up" || keyName === "k") {
      state.modelSelection = clamp(state.modelSelection - 1, 0, rows.length - 1);
      redraw();
      return;
    }

    if (keyName === "down" || keyName === "j") {
      state.modelSelection = clamp(state.modelSelection + 1, 0, rows.length - 1);
      redraw();
      return;
    }

    const row = rows[state.modelSelection];
    if (!row) {
      return;
    }

    if (row.kind === "provider") {
      if (keyName === "left") {
        state.expandedProviders[row.providerKey] = false;
        redraw();
        return;
      }

      if (["right", "enter", "return"].includes(keyName)) {
        state.expandedProviders[row.providerKey] = !state.expandedProviders[row.providerKey];
        redraw();
        return;
      }

      if (keyName === "space") {
        state.config.agents[row.providerKey].enabled = !state.config.agents[row.providerKey].enabled;
        save();
        void refreshUsage("provider toggle");
      }

      return;
    }

    handleModelFieldAction(row, keyName);
  }

  function handleUiSettingsKeys(keyName: string): void {
    const rows: UiRowKey[] = [
      "theme",
      "barStyle",
      "refreshSeconds",
      "detailPaneMode",
      "dashboardMetrics",
      "showModeColumn",
      "heatmapScope",
      "heatmapProvider",
      "heatmapMetric",
      "heatmapChars",
      "heatmapCellWidth",
      "heatmapInfoMode",
      "heatmapPaletteSteps",
      "heatmapMaxDays",
      "decimalPlaces",
    ];
    state.uiSelection = clamp(state.uiSelection, 0, rows.length - 1);

    if (keyName === "up" || keyName === "k") {
      state.uiSelection = clamp(state.uiSelection - 1, 0, rows.length - 1);
      redraw();
      return;
    }

    if (keyName === "down" || keyName === "j") {
      state.uiSelection = clamp(state.uiSelection + 1, 0, rows.length - 1);
      redraw();
      return;
    }

    const row = rows[state.uiSelection];
    if (!row) {
      return;
    }

    if (row === "theme") {
      if (["enter", "return", "left", "right", "a", "d"].includes(keyName)) {
        state.themePopupOpen = true;
        state.themePopupPreviousTheme = state.config.theme;
        state.themePopupSelection = Math.max(0, THEMES.findIndex((theme) => theme.key === state.config.theme));

        const selected = THEMES[state.themePopupSelection] ?? THEMES[0];
        if (selected) {
          state.config.theme = selected.key;
        }

        redraw();
      }
      return;
    }

    if (row === "barStyle") {
      if (keyName === "left" || keyName === "a") {
        changeBarStyle(-1);
        return;
      }
      if (["right", "enter", "return", "d"].includes(keyName)) {
        changeBarStyle(1);
      }
      return;
    }

    if (row === "refreshSeconds") {
      if (keyName === "left" || keyName === "a") {
        changeRefreshPreset(-1);
        return;
      }
      if (["right", "enter", "return", "d"].includes(keyName)) {
        changeRefreshPreset(1);
      }
      return;
    }

    if (row === "detailPaneMode") {
      if (keyName === "left" || keyName === "a") {
        changeDetailPaneMode(-1);
        return;
      }
      if (["right", "enter", "return", "d"].includes(keyName)) {
        changeDetailPaneMode(1);
      }
      return;
    }

    if (row === "dashboardMetrics") {
      if (keyName === "left" || keyName === "a") {
        changeDashboardMetrics(-1);
        return;
      }
      if (["right", "enter", "return", "d"].includes(keyName)) {
        changeDashboardMetrics(1);
      }
      return;
    }

    if (row === "showModeColumn") {
      if (["left", "right", "a", "d", "space", "enter", "return"].includes(keyName)) {
        toggleShowModeColumn();
      }
      return;
    }

    if (row === "heatmapScope") {
      if (keyName === "left" || keyName === "a") {
        changeHeatmapScope(-1);
        return;
      }
      if (["right", "d", "enter", "return"].includes(keyName)) {
        changeHeatmapScope(1);
      }
      return;
    }

    if (row === "heatmapProvider") {
      if (keyName === "left" || keyName === "a") {
        changeHeatmapProvider(-1);
        return;
      }
      if (["right", "d"].includes(keyName)) {
        changeHeatmapProvider(1);
        return;
      }
      if (["enter", "return", "e"].includes(keyName)) {
        openAppTextPrompt(
          "Heatmap provider",
          state.config.heatmapProvider,
          ["Enter provider key", "Examples: github-copilot, claude", "Use left/right to cycle providers quickly"],
          (next) => {
            const candidate = (next ?? "").trim().toLowerCase();
            const found = providerOrder.find((item) => item === candidate);
            if (!found) {
              state.statusLine = "invalid provider key";
              return;
            }
            state.config.heatmapProvider = found;
          },
        );
      }
      return;
    }

    if (row === "heatmapMetric") {
      if (keyName === "left" || keyName === "a") {
        changeHeatmapMetric(-1);
        return;
      }
      if (["right", "d", "enter", "return"].includes(keyName)) {
        changeHeatmapMetric(1);
      }
      return;
    }

    if (row === "heatmapChars") {
      if (["enter", "return", "e"].includes(keyName)) {
        openAppTextPrompt(
          "Heatmap glyph",
          state.config.heatmapChars,
          ["Enter exactly one character (example: ⣿)", "Only the first character will be used"],
          (next) => {
            const source = Array.from((next ?? "").trim());
            state.config.heatmapChars = source[0] ?? "⣿";
          },
        );
      }
      return;
    }

    if (row === "heatmapCellWidth") {
      if (keyName === "left" || keyName === "a") {
        changeHeatmapCellWidth(-1);
        return;
      }
      if (["right", "d", "enter", "return"].includes(keyName)) {
        changeHeatmapCellWidth(1);
      }
      return;
    }

    if (row === "heatmapInfoMode") {
      if (keyName === "left" || keyName === "a") {
        changeHeatmapInfoMode(-1);
        return;
      }
      if (["right", "d", "enter", "return"].includes(keyName)) {
        changeHeatmapInfoMode(1);
      }
      return;
    }

    if (row === "heatmapPaletteSteps") {
      if (keyName === "left" || keyName === "a") {
        changeHeatmapPaletteSteps(-1);
        return;
      }
      if (["right", "d", "enter", "return"].includes(keyName)) {
        changeHeatmapPaletteSteps(1);
      }
      return;
    }

    if (row === "heatmapMaxDays") {
      if (keyName === "left" || keyName === "a") {
        changeHeatmapMaxDays(-1);
        return;
      }
      if (["right", "d", "enter", "return"].includes(keyName)) {
        changeHeatmapMaxDays(1);
      }
      return;
    }

    if (row === "decimalPlaces") {
      if (keyName === "left" || keyName === "a") {
        changeDecimalPlaces(-1);
        return;
      }
      if (["right", "d", "enter", "return"].includes(keyName)) {
        changeDecimalPlaces(1);
      }
      return;
    }
  }

  function handleSettingsKeys(keyName: string): void {
    if (keyName === "tab") {
      state.settingsNavFocused = !state.settingsNavFocused;
      redraw();
      return;
    }

    if (state.settingsNavFocused) {
      const pageIndex = Math.max(0, SETTINGS_PAGES.findIndex((page) => page.key === state.settingsPage));

      if (keyName === "up" || keyName === "k") {
        const next = SETTINGS_PAGES[clamp(pageIndex - 1, 0, SETTINGS_PAGES.length - 1)];
        if (next) {
          state.settingsPage = next.key;
          redraw();
        }
        return;
      }

      if (keyName === "down" || keyName === "j") {
        const next = SETTINGS_PAGES[clamp(pageIndex + 1, 0, SETTINGS_PAGES.length - 1)];
        if (next) {
          state.settingsPage = next.key;
          redraw();
        }
        return;
      }

      if (["right", "enter", "return"].includes(keyName)) {
        state.settingsNavFocused = false;
        redraw();
      }
      return;
    }

    if (keyName === "h") {
      state.settingsNavFocused = true;
      redraw();
      return;
    }

    if (state.settingsPage === "model-settings") {
      handleModelSettingsKeys(keyName);
      return;
    }

    handleUiSettingsKeys(keyName);
  }

  function handleDashboardKeys(keyName: string): void {
    const keys = getEnabledProviderKeys();
    if (keys.length > 0) {
      if (keyName === "up" || keyName === "k") {
        state.dashboardSelection = clamp(state.dashboardSelection - 1, 0, keys.length - 1);
        redraw();
        return;
      }

      if (keyName === "down" || keyName === "j") {
        state.dashboardSelection = clamp(state.dashboardSelection + 1, 0, keys.length - 1);
        redraw();
        return;
      }
    }

    if (keyName === "r") {
      void refreshUsage("manual");
      return;
    }

    if (keyName === "s") {
      state.screen = "settings";
      redraw();
    }
  }

  function handleGlobalKeyPress(key: KeyEvent): void {
    if (state.prompt) {
      handlePromptKey(key);
      return;
    }

    if (state.themePopupOpen) {
      handleThemePopupKey(key);
      return;
    }

    const keyName = key.name.toLowerCase();

    if ((key.ctrl && keyName === "c") || keyName === "q") {
      shutdown();
      return;
    }

    if (state.screen === "dashboard") {
      handleDashboardKeys(keyName);
      return;
    }

    if (keyName === "d") {
      state.screen = "dashboard";
      redraw();
      return;
    }

    handleSettingsKeys(keyName);
  }

  process.on("uncaughtException", () => {
    shutdown();
  });

  process.on("unhandledRejection", () => {
    shutdown();
  });

  renderer.keyInput.on("keypress", (key) => {
    handleGlobalKeyPress(key);
  });

  renderer.keyInput.on("paste", (event: PasteEvent) => {
    if (!state.prompt) {
      return;
    }

    handlePromptPaste(event.text);
  });

  if (process.stdout.isTTY) {
    process.stdout.on("resize", handleTerminalResize);
  }

  startResizeWatcher();

  restartAutoRefresh();
  redraw();
  await refreshUsage("startup");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cycleIndex(length: number, current: number, direction: 1 | -1): number {
  if (length <= 0) {
    return 0;
  }

  return (current + direction + length) % length;
}

function fit(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text.padEnd(width, " ");
  }

  if (width <= 1) {
    return text.slice(0, width);
  }

  return `${text.slice(0, width - 1)}…`;
}

// right-align text into a fixed-width column; if truncated keep the right-most chars
function rfit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padStart(width, " ");
  if (width <= 1) return text.slice(-width);
  return `…${text.slice(-(width - 1))}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
}

function formatMoney(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "$0";
  }

  const rounded = value < 10 ? value.toFixed(2) : value.toFixed(1);
  return `$${rounded}`;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatRefresh(seconds: number): string {
  const found = REFRESH_PRESETS.find((item) => item.seconds === seconds);
  if (found) {
    return found.label;
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }

  return `${Math.round(seconds / 3600)}h`;
}
