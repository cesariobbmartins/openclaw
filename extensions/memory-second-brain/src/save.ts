import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { persistSession } from "./db.js";
import type { PluginConfig, SessionTurn } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function formatTurnsAsMarkdown(turns: SessionTurn[]): string {
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
// Flush daily log (append conversation to GCS FUSE)
// ---------------------------------------------------------------------------

export async function flushDailyLog(cfg: PluginConfig, turns: SessionTurn[]): Promise<void> {
  if (turns.length === 0) return;

  const logPath = join(
    cfg.workspacePath,
    cfg.org,
    "agents",
    cfg.agentId,
    "memory",
    "daily",
    `${todayIso()}.md`,
  );

  await ensureDir(logPath);

  const separator = `\n\n<!-- session ${new Date().toISOString()} -->\n\n`;
  const content = separator + formatTurnsAsMarkdown(turns);

  await appendFile(logPath, content, "utf8");
}

// ---------------------------------------------------------------------------
// Write memory file (used by write_memory tool)
// ---------------------------------------------------------------------------

type MemoryTarget = "memory" | "user";

export async function writeMemoryFile(
  cfg: PluginConfig,
  target: MemoryTarget,
  content: string,
): Promise<void> {
  const filename = target === "memory" ? "MEMORY.md" : "USER.md";
  const path = join(cfg.workspacePath, cfg.org, "agents", cfg.agentId, "memory", filename);
  await ensureDir(path);
  await writeFile(path, content, "utf8");
}

// ---------------------------------------------------------------------------
// Full session flush: daily log + Supabase
// ---------------------------------------------------------------------------

export async function flushSession(
  cfg: PluginConfig,
  sessionId: string,
  turns: SessionTurn[],
): Promise<void> {
  await Promise.allSettled([flushDailyLog(cfg, turns), persistSession(cfg, sessionId, turns)]);
}
