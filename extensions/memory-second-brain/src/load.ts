import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginConfig } from "./types.js";

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
// Load private memory space
// ---------------------------------------------------------------------------

async function loadPrivate(cfg: PluginConfig): Promise<string> {
  const base = join(cfg.workspacePath, cfg.org, "agents", cfg.agentId, "memory");

  const [soul, user, memory, daily] = await Promise.all([
    readOptionalFile(join(base, "SOUL.md")),
    readOptionalFile(join(base, "USER.md")),
    readOptionalFile(join(base, "MEMORY.md")),
    readOptionalFile(join(base, "daily", `${todayIso()}.md`)),
  ]);

  const dailyTail = daily ? tail(daily, cfg.dailyTailLines) : null;

  return [
    section("Identity (SOUL)", soul),
    section("User Profile (USER)", user),
    section("Long-term Memory (MEMORY)", memory),
    section(`Today's Log (${todayIso()})`, dailyTail),
  ].join("");
}

// ---------------------------------------------------------------------------
// Load org space (read-only for the agent)
// ---------------------------------------------------------------------------

async function loadOrg(cfg: PluginConfig): Promise<string> {
  const base = join(cfg.workspacePath, cfg.org, "org");

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
      const path = join(cfg.workspacePath, cfg.org, "projects", projectId, "CONTEXT.md");
      const content = await readOptionalFile(path);
      return content ? section(`Project: ${projectId}`, content) : "";
    }),
  );

  return contexts.join("");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function loadContext(cfg: PluginConfig, projectIds: string[]): Promise<string> {
  const [privateCtx, orgCtx, projectsCtx] = await Promise.all([
    loadPrivate(cfg),
    loadOrg(cfg),
    loadProjects(cfg, projectIds),
  ]);

  const parts = [privateCtx, orgCtx, projectsCtx].filter(Boolean);
  if (parts.length === 0) return "";

  return `<!-- Second Brain Memory Context -->\n${parts.join("")}\n<!-- End Memory Context -->`;
}
