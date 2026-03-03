export interface PluginConfig {
  org: string;
  agentId: string;
  workspacePath: string;
  supabaseUrl?: string;
  supabaseKey?: string;
  dailyTailLines: number;
}

export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}
