import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePath, type PluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

interface Turn {
  role: string;
  content: string;
  timestamp: string;
}

function formatTurnsAsMarkdown(turns: Turn[]): string {
  const lines = turns.map((t) => {
    const prefix = t.role === "user" ? "**User**" : "**Assistant**";
    return `${prefix} (${t.timestamp})\n\n${t.content}\n`;
  });
  return lines.join("\n---\n\n");
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

// ---------------------------------------------------------------------------
// Flush daily log (append conversation to GCS FUSE — workspace root)
// ---------------------------------------------------------------------------

export async function flushDailyLog(cfg: PluginConfig, turns: Turn[]): Promise<void> {
  if (turns.length === 0) return;

  const logPath = join(
    safePath(cfg.workspacePath, cfg.org, "agents", cfg.agentId),
    "daily",
    `${todayIso()}.md`,
  );

  await ensureDir(logPath);

  const separator = `\n\n<!-- session ${new Date().toISOString()} -->\n\n`;
  const content = separator + formatTurnsAsMarkdown(turns);

  await appendFile(logPath, content, "utf8");
}

// ---------------------------------------------------------------------------
// Write memory file (used by write_memory tool — writes to workspace root
// where OpenClaw natively reads and RAG indexes)
// ---------------------------------------------------------------------------

type MemoryTarget = "memory" | "user";

export async function writeMemoryFile(
  cfg: PluginConfig,
  target: MemoryTarget,
  content: string,
): Promise<void> {
  const filename = target === "memory" ? "MEMORY.md" : "USER.md";
  const path = join(safePath(cfg.workspacePath, cfg.org, "agents", cfg.agentId), filename);
  await ensureDir(path);
  await writeFile(path, content, "utf8");
}
