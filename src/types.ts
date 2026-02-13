export type AgentKey = "github-copilot" | "codex" | "claude" | "zai" | "minimax" | "vercel-ai";

export type BillingMode = "quota" | "payg";

export type BarStyle = "solid" | "shaded" | "ascii" | "dots" | "pipe" | "braille";

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
}

export interface AgentProvider {
  key: AgentKey;
  label: string;
  accent: string;
  description: string;
  supportsLiveFetch: boolean;
  credentialName: "token" | "apiKey";
  isConfigured: (cfg: AgentConfig) => boolean;
  fetchUsage: (cfg: AgentConfig) => Promise<UsageResult>;
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
  fetchedAt?: string;
}
