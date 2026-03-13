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

function section(title: string, content: string | null): string {
  if (!content?.trim()) return "";
  return `\n\n---\n## ${title}\n\n${content.trim()}`;
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
// Load TAGS.md (tag vocabulary for consistency)
// ---------------------------------------------------------------------------

async function loadTags(cfg: PluginConfig): Promise<string> {
  const path = join(safePath(cfg.workspacePath, cfg.org, "agents", cfg.agentId), "TAGS.md");
  const content = await readOptionalFile(path);
  return section("Tag Vocabulary (TAGS)", content);
}

// ---------------------------------------------------------------------------
// Main export — loads org + project context + tags
// ---------------------------------------------------------------------------

export async function loadContext(cfg: PluginConfig, projectIds: string[]): Promise<string> {
  const [orgCtx, projectsCtx, tagsCtx] = await Promise.all([
    loadOrg(cfg),
    loadProjects(cfg, projectIds),
    loadTags(cfg),
  ]);

  const parts = [orgCtx, projectsCtx, tagsCtx].filter(Boolean);
  if (parts.length === 0) return "";

  return `<!-- Second Brain Extension Context -->\n${parts.join("")}\n<!-- End Extension Context -->`;
}
