import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safePath, type PluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function tail(content: string, lines: number): string {
  const all = content.split("\n");
  return all.slice(-lines).join("\n");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function section(title: string, content: string | null): string {
  if (!content?.trim()) return "";
  return `\n\n---\n## ${title}\n\n${content.trim()}`;
}

// ---------------------------------------------------------------------------
// Load today's daily log tail (from workspace root, alongside SOUL.md etc.)
// ---------------------------------------------------------------------------

async function loadDailyTail(cfg: PluginConfig): Promise<string> {
  const agentRoot = safePath(cfg.workspacePath, cfg.org, "agents", cfg.agentId);
  const daily = await readOptionalFile(join(agentRoot, "daily", `${todayIso()}.md`));
  const dailyTail = daily ? tail(daily, cfg.dailyTailLines) : null;
  return section(`Today's Log (${todayIso()})`, dailyTail);
}

// ---------------------------------------------------------------------------
// Load org space (read-only for the agent)
// ---------------------------------------------------------------------------

async function loadOrg(cfg: PluginConfig): Promise<string> {
  const base = safePath(cfg.workspacePath, cfg.org, "org");

  const [strategy, culture] = await Promise.all([
    readOptionalFile(join(base, "STRATEGY.md")),
    readOptionalFile(join(base, "CULTURE.md")),
  ]);

  return [
    section("Company Strategy (STRATEGY)", strategy),
    section("Company Culture (CULTURE)", culture),
  ].join("");
}

// ---------------------------------------------------------------------------
// Load project spaces
// ---------------------------------------------------------------------------

async function loadProjects(cfg: PluginConfig, projectIds: string[]): Promise<string> {
  if (projectIds.length === 0) return "";

  const contexts = await Promise.all(
    projectIds.map(async (projectId) => {
      const path = join(safePath(cfg.workspacePath, cfg.org, "projects", projectId), "CONTEXT.md");
      const content = await readOptionalFile(path);
      return content ? section(`Project: ${projectId}`, content) : "";
    }),
  );

  return contexts.join("");
}

// ---------------------------------------------------------------------------
// Main export — only loads what OpenClaw doesn't handle natively
// ---------------------------------------------------------------------------

export async function loadContext(cfg: PluginConfig, projectIds: string[]): Promise<string> {
  const [dailyCtx, orgCtx, projectsCtx] = await Promise.all([
    loadDailyTail(cfg),
    loadOrg(cfg),
    loadProjects(cfg, projectIds),
  ]);

  const parts = [dailyCtx, orgCtx, projectsCtx].filter(Boolean);
  if (parts.length === 0) return "";

  return `<!-- Second Brain Extension Context -->\n${parts.join("")}\n<!-- End Extension Context -->`;
}
