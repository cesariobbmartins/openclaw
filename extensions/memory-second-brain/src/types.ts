export interface PluginConfig {
  org: string;
  agentId: string;
  workspacePath: string;
  databaseUrl?: string;
  dailyTailLines: number;
}
