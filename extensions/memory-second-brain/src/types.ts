import { join, resolve } from "node:path";

export interface PluginConfig {
  org: string;
  agentId: string;
  workspacePath: string;
  databaseUrl?: string;
  dailyTailLines: number;
}

/**
 * Validates that a path segment is safe (no traversal) and returns
 * a resolved path under workspacePath. Throws on any traversal attempt.
 */
export function safePath(workspacePath: string, ...segments: string[]): string {
  for (const s of segments) {
    if (/[/\\]|\.\./.test(s)) {
      throw new Error(`Invalid path segment: ${s}`);
    }
  }
  const full = resolve(join(workspacePath, ...segments));
  const base = resolve(workspacePath);
  if (!full.startsWith(base + "/") && full !== base) {
    throw new Error(`Path escapes workspace: ${full}`);
  }
  return full;
}
