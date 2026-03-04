import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePath, type PluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SKILL_SIZE = 50_000; // 50 KB
const MAX_PERSONAL_SKILLS = 10;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SkillInfo {
  name: string;
  description: string;
  tier: "org" | "personal";
  path: string;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const descMatch = yaml.match(/^description:\s*>?\s*\n([\s\S]*?)(?=\n\w|\n---)/m);
  const descInline = yaml.match(/^description:\s*(?!>)(.+)$/m)?.[1]?.trim();
  const description = descMatch ? descMatch[1].trim().replace(/\n\s*/g, " ") : descInline;

  return { name, description };
}

async function scanSkillDir(dir: string, tier: "org" | "personal"): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const skillMd = join(dir, entry, "SKILL.md");
    try {
      const content = await readFile(skillMd, "utf8");
      const { name, description } = parseFrontmatter(content);
      skills.push({
        name: name ?? entry,
        description: description ?? "(no description)",
        tier,
        path: skillMd,
      });
    } catch {
      // Not a valid skill directory — skip
    }
  }

  return skills;
}

// ---------------------------------------------------------------------------
// list_skills — scan org + personal skill directories
// ---------------------------------------------------------------------------

export async function listSkills(cfg: PluginConfig): Promise<SkillInfo[]> {
  const orgDir = safePath(cfg.workspacePath, cfg.org, "org", "skills");
  const personalDir = safePath(cfg.workspacePath, cfg.org, "agents", cfg.agentId, "skills");

  const [orgSkills, personalSkills] = await Promise.all([
    scanSkillDir(orgDir, "org"),
    scanSkillDir(personalDir, "personal"),
  ]);

  return [...orgSkills, ...personalSkills];
}

// ---------------------------------------------------------------------------
// write_skill — create/update personal skill
// ---------------------------------------------------------------------------

export interface WriteSkillResult {
  ok: boolean;
  message: string;
  path?: string;
}

export async function writeSkill(
  cfg: PluginConfig,
  name: string,
  content: string,
): Promise<WriteSkillResult> {
  // Validate name
  if (!SKILL_NAME_RE.test(name)) {
    return {
      ok: false,
      message: `Invalid skill name "${name}". Use lowercase letters, numbers, and hyphens (2-64 chars).`,
    };
  }

  // Validate size
  if (content.length > MAX_SKILL_SIZE) {
    return {
      ok: false,
      message: `Content too large (${content.length} chars, max ${MAX_SKILL_SIZE}).`,
    };
  }

  // Validate frontmatter
  const { name: fmName, description } = parseFrontmatter(content);
  if (!fmName || !description) {
    return {
      ok: false,
      message: "SKILL.md must have YAML frontmatter with 'name' and 'description' fields.",
    };
  }

  // Check skill count (exclude the one being updated)
  const personalDir = safePath(cfg.workspacePath, cfg.org, "agents", cfg.agentId, "skills");
  let existingCount = 0;
  let isUpdate = false;
  try {
    const entries = await readdir(personalDir);
    for (const e of entries) {
      if (!e.startsWith(".")) existingCount++;
      if (e === name) isUpdate = true;
    }
  } catch {
    // Dir doesn't exist yet — count is 0
  }

  if (!isUpdate && existingCount >= MAX_PERSONAL_SKILLS) {
    return {
      ok: false,
      message: `Personal skill limit reached (max ${MAX_PERSONAL_SKILLS}). Delete a skill before creating a new one.`,
    };
  }

  // Write
  const skillPath = join(personalDir, name, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, content, "utf8");

  return {
    ok: true,
    message: isUpdate
      ? `Skill "${name}" updated successfully.`
      : `Skill "${name}" created successfully.`,
    path: skillPath,
  };
}
