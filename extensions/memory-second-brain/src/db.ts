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
