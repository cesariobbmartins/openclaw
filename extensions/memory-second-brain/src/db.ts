import pg from "pg";
import type { PluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Client (lazy singleton)
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

function getPool(cfg: PluginConfig): pg.Pool | null {
  if (!cfg.databaseUrl) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: cfg.databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Project membership
// ---------------------------------------------------------------------------

export async function getAgentProjects(cfg: PluginConfig): Promise<string[]> {
  const db = getPool(cfg);
  if (!db) return [];

  try {
    const { rows } = await db.query<{ project_id: string }>(
      "SELECT project_id FROM project_members WHERE org_id = $1 AND agent_id = $2",
      [cfg.org, cfg.agentId],
    );
    return rows.map((r) => r.project_id);
  } catch (err) {
    console.warn("[memory-second-brain] failed to load projects:", String(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Skill secrets
// ---------------------------------------------------------------------------

export async function getSkillSecrets(
  cfg: PluginConfig,
): Promise<Map<string, Map<string, string>>> {
  const db = getPool(cfg);
  if (!db) return new Map();

  try {
    const { rows } = await db.query<{
      skill_name: string;
      secret_key: string;
      secret_value: string;
    }>("SELECT skill_name, secret_key, secret_value FROM skill_secrets WHERE org_id = $1", [
      cfg.org,
    ]);

    const secrets = new Map<string, Map<string, string>>();
    for (const r of rows) {
      if (!secrets.has(r.skill_name)) {
        secrets.set(r.skill_name, new Map());
      }
      secrets.get(r.skill_name)!.set(r.secret_key, r.secret_value);
    }
    return secrets;
  } catch (err) {
    console.warn("[memory-second-brain] failed to load skill secrets:", String(err));
    return new Map();
  }
}
