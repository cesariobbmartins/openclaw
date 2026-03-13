import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePath, type PluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function agentRoot(cfg: PluginConfig): string {
  return safePath(cfg.workspacePath, cfg.org, "agents", cfg.agentId);
}

// ---------------------------------------------------------------------------
// Write USER.md (used by write_user tool — writes to workspace root
// where OpenClaw natively reads and injects into system prompt)
// ---------------------------------------------------------------------------

export async function writeUserFile(cfg: PluginConfig, content: string): Promise<void> {
  const path = join(agentRoot(cfg), "USER.md");
  await ensureDir(path);
  await writeFile(path, content, "utf8");
}
