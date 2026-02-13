export type AgentKey =
  | "github-copilot"
  | "codex"
  | "claude"
  | "zai"
  | "minimax"
  | "vercel-ai"
  | "ollama"
  | "openrouter"
  | "cursor"
  | "antigravity"
  | "opencode";

export type BillingMode = "quota" | "payg";

export type BarStyle = "solid" | "shaded" | "ascii" | "dots" | "pipe" | "braille";
export type HeatmapMetric = "req" | "cost";
export type HeatmapInfoMode = "none" | "days" | "week" | "year" | "all";
export type HeatmapScope = "focused" | "provider" | "total";

export interface DailyUsagePoint {
  day: string; // YYYY-MM-DD (UTC)
  used: number;
  cost: number;
}

export interface AgentConfig {
  enabled: boolean;
  billingMode: BillingMode;
  accentColor?: string;
  token?: string;
  apiKey?: string;
  username?: string;
  monthlyLimit?: number;
  costLimit?: number;
  manualUsed?: number;
  manualCost?: number;
}

export interface AppConfig {
  theme: string;
  refreshSeconds: number;
  barStyle: BarStyle;
  dashboardMetrics?: "req" | "cost" | "both";
  showModeColumn?: boolean;
  heatmapScope?: HeatmapScope;
  heatmapProvider?: AgentKey | "all";
  heatmapMetric?: HeatmapMetric;
  heatmapChars?: string;
  heatmapCellWidth?: number;
  heatmapInfoMode?: HeatmapInfoMode;
  heatmapPaletteSteps?: number;
  heatmapMaxDays?: number;
  decimalPlaces?: number;
  selectedAgent: AgentKey;
  agents: Record<AgentKey, AgentConfig>;
  // optional UI preference persisted across runs
  detailPaneMode?: "sidebar" | "bottom" | "hidden";
}

export interface UsageBreakdownItem {
  label: string;
  used: number;
  cost: number;
}

export interface UsageResult {
  used: number;
  limit?: number;
  unit: string;
  cost?: number;
  details: string[];
  breakdown?: UsageBreakdownItem[];
  daily?: DailyUsagePoint[];
  fetchedMonths?: number;
}

export interface AgentProvider {
  key: AgentKey;
  label: string;
  accent: string;
  description: string;
  supportsLiveFetch: boolean;
  credentialName: "token" | "apiKey";
  isConfigured: (cfg: AgentConfig) => boolean;
  fetchUsage: (cfg: AgentConfig, onUpdate?: (partial: Partial<UsageResult>) => void) => Promise<UsageResult>;
}

export type Screen = "dashboard" | "settings";

export interface AgentSnapshot {
  key: AgentKey;
  label: string;
  accent: string;
  enabled: boolean;
  configured: boolean;
  billingMode: BillingMode;
  loading: boolean;
  error?: string;
  used: number;
  limit?: number;
  unit: string;
  cost?: number;
  progress: number;
  details: string[];
  breakdown: UsageBreakdownItem[];
  daily: DailyUsagePoint[];
  fetchedMonths?: number;
  revealCursor?: number;
  fetchedAt?: string;
}
