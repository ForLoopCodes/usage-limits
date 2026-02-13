import { Box, Text, createCliRenderer, fg, t, type KeyEvent, type PasteEvent } from "@opentui/core";
import { loadConfig, saveConfig } from "./config";
import { getProvider, PROVIDERS } from "./providers";
import { THEMES, getTheme, type ThemeDefinition } from "./themes";
import type { AgentKey, AgentProvider, AgentSnapshot, BillingMode, Screen } from "./types";
import { BAR_STYLE_OPTIONS, REFRESH_PRESETS, SETTINGS_PAGES } from "./ui/constants";
import { toBar } from "./ui/format";

const DEFAULT_AGENT: AgentKey = "github-copilot";

type DetailPaneMode = "sidebar" | "bottom" | "hidden";
type SettingsPageKey = (typeof SETTINGS_PAGES)[number]["key"];
type ModelFieldKey = "enabled" | "billingMode" | "credential" | "username" | "monthlyLimit" | "costLimit" | "manualUsed" | "manualCost";
type UiRowKey = "theme" | "barStyle" | "refreshSeconds" | "detailPaneMode";

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
  themePopupOpen: boolean;
  themePopupSelection: number;
  refreshing: boolean;
  lastUpdatedAt: string;
  refreshTimer: Timer | null;
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
    case "username":
      return "Account handle used for billing API";
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
    },
    prompt: null,
    themePopupOpen: false,
    themePopupSelection: Math.max(0, THEMES.findIndex((theme) => theme.key === loadedConfig.theme)),
    refreshing: false,
    lastUpdatedAt: "--:--:--",
    refreshTimer: null,
    statusLine: "ready",
    shuttingDown: false,
  };

  const providerOrder = PROVIDERS.map((provider) => provider.key);

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

  function usageCell(key: AgentKey): string {
    const snapshot = state.snapshots[key];
    const cfg = state.config.agents[key];

    const used = `${formatNumber(snapshot.used)}${snapshot.unit}`;
    const usageLimit = cfg.billingMode === "quota" ? (typeof cfg.monthlyLimit === "number" ? formatNumber(cfg.monthlyLimit) : "∞") : "∞";
    return `${used}/${usageLimit}`;
  }

  function costCell(key: AgentKey): string {
    const snapshot = state.snapshots[key];
    const cfg = state.config.agents[key];

    const limit = typeof cfg.costLimit === "number" ? formatMoney(cfg.costLimit) : "∞";
    return `${formatMoney(snapshot.cost)}/${limit}`;
  }

  function openPrompt(prompt: PromptState): void {
    state.prompt = prompt;
    state.themePopupOpen = false;
    redraw();
  }

  function closePrompt(): void {
    state.prompt = null;
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

  function openCredentialPrompt(providerKey: AgentKey): void {
    const provider = getProvider(providerKey);

    if (providerKey === "github-copilot") {
      openPrompt({
        providerKey,
        title: provider.label,
        instructions: [
          "GitHub token: fine-grained PAT or GitHub App user token",
          "Permission needed: Plan (read)",
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
            ["Enter your GitHub username/handle", "This is used in /users/{username}/settings/billing/premium_request/usage"],
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

  function buildHeader(theme: ThemeDefinition) {
    const refreshChunk = `${formatRefresh(state.config.refreshSeconds)} ${state.lastUpdatedAt}`;

    return Box(
      {
        width: "100%",
        backgroundColor: theme.appBg,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "row",
        justifyContent: "space-between",
      },
      Text({ content: t`${fg(theme.warning)("USAGE LIMITS MONITOR")}`, truncate: true }),
      Text({ content: refreshChunk, fg: theme.success, truncate: true }),
    );
  }

  function buildCommandBar(theme: ThemeDefinition) {
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
          ["←/→", "change"],
          ["enter", "edit"],
          ["space", "toggle"],
        ];

    const items = segments.flatMap(([key, label]) => [
      Text({ content: ` ${key} `, fg: theme.warning }),
      Text({ content: ` ${label}  `, fg: theme.muted }),
    ]);

    items.push(Text({ content: state.statusLine, fg: theme.text, truncate: true }));

    return Box(
      {
        width: "100%",
        backgroundColor: theme.appBg,
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
      },
      ...items,
    );
  }

  function buildDetailPane(theme: ThemeDefinition, key: AgentKey, width: number) {
    const snapshot = state.snapshots[key];
    const cfg = state.config.agents[key];

    const fadeColors = [theme.text, "#b8c0d4", "#9aa4c0", "#808ca8", theme.muted];
    const modelRows = snapshot.breakdown.slice(0, 5).map((item, index) => {
      const c = fadeColors[index] ?? theme.muted;
      const model = fit(item.label, 24);
      const req = fit(`${formatNumber(item.used)} req`, 10);
      const cost = fit(formatMoney(item.cost), 8);
      return Text({ content: `${model}${req}${cost}`, fg: c, truncate: true });
    });

    return Box(
      {
        width,
        backgroundColor: theme.appBg,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "column",
      },
      Text({ content: snapshot.label, fg: theme.warning, truncate: true }),
      Text({ content: `username: ${cfg.username ?? "-"}`, fg: theme.text, truncate: true }),
      Text({ content: "", fg: theme.text }),
      Text({ content: fit("model", 24) + fit("req", 10) + fit("cost", 8), fg: theme.success, truncate: true }),
      ...(modelRows.length > 0 ? modelRows : [Text({ content: "No model rows available", fg: theme.muted, truncate: true })]),
    );
  }

  function resolveEffectiveDetailPaneMode(): DetailPaneMode {
    const configured = state.config.detailPaneMode ?? "sidebar";
    if (configured === "hidden") {
      return "hidden";
    }

    if (renderer.width < 130) {
      return "bottom";
    }

    return configured;
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

    const effectiveDetailMode = resolveEffectiveDetailPaneMode();
    const sideWidth = effectiveDetailMode === "sidebar" ? Math.min(44, Math.max(32, Math.floor(renderer.width * 0.32))) : 0;

    const availableTableWidth = Math.max(64, renderer.width - 4 - (effectiveDetailMode === "sidebar" ? sideWidth : 0));
    const colProvider = clamp(Math.floor(availableTableWidth * 0.2), 14, 24);
    const colMode = 8;
    const colUsage = clamp(Math.floor(availableTableWidth * 0.2), 16, 24);
    const colCost = clamp(Math.floor(availableTableWidth * 0.16), 14, 20);
    const colBar = Math.max(10, availableTableWidth - colProvider - colMode - colUsage - colCost);
    const tableWidth = colProvider + colMode + colBar + colUsage + colCost;

    const headerRow = Box(
      { width: tableWidth, flexDirection: "row" },
      Text({ content: fit("Provider", colProvider), fg: theme.warning, truncate: true }),
      Text({ content: fit("Mode", colMode), fg: theme.warning, truncate: true }),
      Text({ content: fit("Progress", colBar), fg: theme.warning, truncate: true }),
      Text({ content: fit("Usage", colUsage), fg: theme.warning, truncate: true }),
      Text({ content: fit("Cost", colCost), fg: theme.warning, truncate: true }),
    );

    const rows = enabled.map((key, index) => {
      const snapshot = state.snapshots[key];
      const rowSelected = index === state.dashboardSelection;
      const mode = snapshot.billingMode === "payg" ? "PAYG" : "QUOTA";
      const bar = toBar(snapshot.progress, Math.max(1, colBar - 7), state.config.barStyle);
      const progress = `${bar.fill}${bar.empty} ${bar.percent}`;

      return Box(
        {
          width: tableWidth,
          flexDirection: "row",
          backgroundColor: rowSelected ? theme.selectionBg : "transparent",
        },
        Text({ content: fit(snapshot.label, colProvider), fg: rowSelected ? theme.selectionText : theme.text, truncate: true }),
        Text({ content: fit(mode, colMode), fg: rowSelected ? theme.selectionText : theme.muted, truncate: true }),
        Text({ content: fit(progress, colBar), fg: rowSelected ? theme.selectionText : snapshot.accent, truncate: true }),
        Text({ content: fit(usageCell(key), colUsage), fg: rowSelected ? theme.selectionText : theme.text, truncate: true }),
        Text({ content: fit(costCell(key), colCost), fg: rowSelected ? theme.selectionText : theme.text, truncate: true }),
      );
    });

    const tableColumn = Box(
      {
        flexGrow: 1,
        alignItems: "center",
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
          paddingTop: 1,
        },
        tableColumn,
      );
    }

    if (effectiveDetailMode === "bottom") {
      return Box(
        {
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: theme.appBg,
          paddingTop: 1,
        },
        tableColumn,
        buildDetailPane(theme, selectedKey, Math.max(48, renderer.width - 2)),
      );
    }

    return Box(
      {
        flexGrow: 1,
        flexDirection: "row",
        backgroundColor: theme.appBg,
        paddingTop: 1,
      },
      tableColumn,
      buildDetailPane(theme, selectedKey, sideWidth),
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
        return `[ ${cfg.enabled ? "ON" : "OFF"} ]`;
      case "billingMode":
        return `< ${cfg.billingMode.toUpperCase()} >`;
      case "credential":
        return `[ ${provider.isConfigured(cfg) ? "configured" : "edit"} ]`;
      case "username":
        return `[ ${cfg.username?.trim() ? cfg.username : "unset"} ]`;
      case "monthlyLimit":
        return `< ${typeof cfg.monthlyLimit === "number" ? formatNumber(cfg.monthlyLimit) : "none"} >`;
      case "costLimit":
        return `< ${typeof cfg.costLimit === "number" ? formatMoney(cfg.costLimit) : "none"} >`;
      case "manualUsed":
        return `< ${typeof cfg.manualUsed === "number" ? formatNumber(cfg.manualUsed) : "0"} >`;
      case "manualCost":
        return `< ${typeof cfg.manualCost === "number" ? formatMoney(cfg.manualCost) : "$0"} >`;
      default:
        return "";
    }
  }

  function buildModelSettingsPanel(theme: ThemeDefinition, contentWidth: number) {
    const rows = getModelRows();
    if (rows.length === 0) {
      return Box({}, Text({ content: "No providers found.", fg: theme.warning }));
    }

    state.modelSelection = clamp(state.modelSelection, 0, rows.length - 1);

    const leftWidth = clamp(Math.floor(contentWidth * 0.68), 36, Math.max(36, contentWidth - 16));
    const rightWidth = Math.max(14, contentWidth - leftWidth);

    const rendered = rows.map((row, index) => {
      const selected = !state.settingsNavFocused && state.settingsPage === "model-settings" && state.modelSelection === index;

      if (row.kind === "provider") {
        const expanded = state.expandedProviders[row.providerKey];
        const snapshot = state.snapshots[row.providerKey];

        return Box(
          {
            width: "100%",
            flexDirection: "row",
            backgroundColor: selected ? theme.selectionBg : "transparent",
          },
          Text({
            content: fit(`${expanded ? "▾" : "▸"} ${snapshot.label}`, leftWidth),
            fg: selected ? theme.selectionText : theme.warning,
            truncate: true,
          }),
          Text({
            content: fit(`[ ${snapshot.enabled ? "ON" : "OFF"} ]`, rightWidth),
            fg: selected ? theme.selectionText : theme.success,
            truncate: true,
          }),
        );
      }

      return Box(
        {
          width: "100%",
          flexDirection: "row",
          backgroundColor: selected ? theme.selectionBg : "transparent",
        },
        Text({
          content: fit(`  ${row.field} — ${fieldDescription(row.field)}`, leftWidth),
          fg: selected ? theme.selectionText : theme.text,
          truncate: true,
        }),
        Text({
          content: fit(modelControl(row.providerKey, row.field), rightWidth),
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
      ...rendered,
    );
  }

  function buildUiSettingsPanel(theme: ThemeDefinition, contentWidth: number) {
    const rows: UiRowKey[] = ["theme", "barStyle", "refreshSeconds", "detailPaneMode"];
    state.uiSelection = clamp(state.uiSelection, 0, rows.length - 1);

    const leftWidth = clamp(Math.floor(contentWidth * 0.68), 36, Math.max(36, contentWidth - 16));
    const rightWidth = Math.max(14, contentWidth - leftWidth);

    const rendered = rows.map((row, index) => {
      const selected = !state.settingsNavFocused && state.settingsPage === "ui-settings" && state.uiSelection === index;

      let label = "";
      let value = "";

      if (row === "theme") {
        label = "theme — open centered theme picker popup";
        value = `[ ${getThemeSafe().label} ]`;
      }

      if (row === "barStyle") {
        label = "usage bars — progress visual style";
        value = `< ${state.config.barStyle} >`;
      }

      if (row === "refreshSeconds") {
        label = "update timing — automatic refresh interval";
        value = `< ${formatRefresh(state.config.refreshSeconds)} >`;
      }

      if (row === "detailPaneMode") {
        label = "details pane — sidebar / bottom / hidden";
        value = `< ${state.config.detailPaneMode} >`;
      }

      if (row === "detailPaneMode") {
        label = "details pane — sidebar / bottom / hidden";
        value = `< ${state.config.detailPaneMode} >`;
      }

      return Box(
        {
          width: "100%",
          flexDirection: "row",
          backgroundColor: selected ? theme.selectionBg : "transparent",
        },
        Text({ content: fit(label, leftWidth), fg: selected ? theme.selectionText : theme.text, truncate: true }),
        Text({ content: fit(value, rightWidth), fg: selected ? theme.selectionText : theme.success, truncate: true }),
      );
    });

    return Box(
      {
        width: "100%",
        flexDirection: "column",
        backgroundColor: theme.appBg,
      },
      ...rendered,
    );
  }

  function buildSettings(theme: ThemeDefinition) {
    const navWidth = 24;
    const contentWidth = Math.max(48, renderer.width - navWidth - 4);

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
          fg: focused ? theme.selectionText : selected ? theme.warning : theme.text,
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
        title: prompt.title,
        titleAlignment: "center",
        backgroundColor: theme.appBg,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
      },
      ...prompt.instructions.map((line) => Text({ content: line, fg: theme.muted, truncate: true })),
      Text({ content: "", fg: theme.text }),
      Text({ content: `> ${prompt.secret ? "*".repeat(prompt.value.length) : prompt.value}`, fg: theme.text, truncate: true }),
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
        title: "Theme",
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

    const old = renderer.root.getRenderable("app-root");
    if (old) {
      renderer.root.remove("app-root");
    }

    const children = [buildHeader(theme), state.screen === "dashboard" ? buildDashboard(theme) : buildSettings(theme), buildCommandBar(theme)];

    if (state.prompt || state.themePopupOpen) {
      children.push(buildOverlay());

      if (state.themePopupOpen) {
        children.push(buildThemePopup(theme));
      }

      if (state.prompt) {
        children.push(buildPromptPopup(theme));
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
        ...children,
      ),
    );
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
        snapshot.accent = provider.accent;
        snapshot.label = provider.label;

        if (!cfg.enabled) {
          snapshot.loading = false;
          snapshot.error = undefined;
          snapshot.used = 0;
          snapshot.limit = cfg.billingMode === "quota" ? cfg.monthlyLimit : undefined;
          snapshot.cost = 0;
          snapshot.progress = 0;
          snapshot.breakdown = [];
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
          snapshot.details = ["missing credentials"];
          return;
        }

        try {
          snapshot.loading = true;
          const usage = await provider.fetchUsage(cfg);
          const limit = cfg.billingMode === "quota" ? usage.limit ?? cfg.monthlyLimit : undefined;

          snapshot.loading = false;
          snapshot.error = undefined;
          snapshot.used = usage.used;
          snapshot.limit = limit;
          snapshot.unit = usage.unit;
          snapshot.cost = usage.cost ?? 0;
          snapshot.progress = pickConfiguredProgress(cfg.billingMode, usage.used, limit);
          snapshot.breakdown = usage.breakdown ?? [];
          snapshot.details = usage.details;
          snapshot.fetchedAt = formatClock(new Date());
        } catch (error) {
          snapshot.loading = false;
          snapshot.error = error instanceof Error ? error.message : String(error);
          snapshot.progress = 0;
          snapshot.breakdown = [];
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
      prompt.value = prompt.value.slice(0, -1);
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

    if (name === "escape") {
      state.themePopupOpen = false;
      redraw();
      return;
    }

    if (name === "up" || name === "k") {
      state.themePopupSelection = cycleIndex(THEMES.length, state.themePopupSelection, -1);
      redraw();
      return;
    }

    if (name === "down" || name === "j") {
      state.themePopupSelection = cycleIndex(THEMES.length, state.themePopupSelection, 1);
      redraw();
      return;
    }

    if (name === "enter" || name === "return") {
      const selected = THEMES[state.themePopupSelection] ?? THEMES[0];
      if (selected) {
        state.config.theme = selected.key;
        save();
      }
      state.themePopupOpen = false;
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

    if (row.field === "billingMode" && ["enter", "return", "left", "right"].includes(keyName)) {
      toggleBillingMode(row.providerKey);
      return;
    }

    if (row.field === "credential" && ["enter", "return", "e"].includes(keyName)) {
      openCredentialPrompt(row.providerKey);
      return;
    }

    if (row.field === "username" && ["enter", "return", "e"].includes(keyName)) {
      openTextPrompt(
        row.providerKey,
        cfg.username,
        ["Set username/handle for this provider", "For GitHub use your account handle, not email"],
        (next) => {
          cfg.username = next;
        },
      );
      return;
    }

    if (row.field === "monthlyLimit") {
      if (keyName === "left") {
        stepNumeric(row.providerKey, "monthlyLimit", -1);
        return;
      }
      if (keyName === "right") {
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
      if (keyName === "left") {
        stepNumeric(row.providerKey, "costLimit", -1);
        return;
      }
      if (keyName === "right") {
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
      if (keyName === "left") {
        stepNumeric(row.providerKey, "manualUsed", -1);
        return;
      }
      if (keyName === "right") {
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
      if (keyName === "left") {
        stepNumeric(row.providerKey, "manualCost", -1);
        return;
      }
      if (keyName === "right") {
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
    const rows: UiRowKey[] = ["theme", "barStyle", "refreshSeconds", "detailPaneMode"];
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
      if (["enter", "return", "left", "right"].includes(keyName)) {
        state.themePopupOpen = true;
        state.themePopupSelection = Math.max(0, THEMES.findIndex((theme) => theme.key === state.config.theme));
        redraw();
      }
      return;
    }

    if (row === "barStyle") {
      if (keyName === "left") {
        changeBarStyle(-1);
        return;
      }
      if (["right", "enter", "return"].includes(keyName)) {
        changeBarStyle(1);
      }
      return;
    }

    if (row === "refreshSeconds") {
      if (keyName === "left") {
        changeRefreshPreset(-1);
        return;
      }
      if (["right", "enter", "return"].includes(keyName)) {
        changeRefreshPreset(1);
      }
      return;
    }

    if (row === "detailPaneMode") {
      if (keyName === "left") {
        changeDetailPaneMode(-1);
        return;
      }
      if (["right", "enter", "return"].includes(keyName)) {
        changeDetailPaneMode(1);
      }
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

    if (keyName === "left") {
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

  restartAutoRefresh();
  redraw();
  ensureFirstMissingConfigPrompt();
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
