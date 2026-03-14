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

// ---------------------------------------------------------------------------
// Visible agents — personal + allowed functionals (DEC-014)
// ---------------------------------------------------------------------------

export interface AgentRow {
  agent_id: string;
  org_id: string;
  name: string;
  type: string;
  active: boolean;
  created_by: string | null;
}

export async function getVisibleAgents(cfg: PluginConfig): Promise<AgentRow[]> {
  const db = getPool(cfg);
  if (!db) return [];

  try {
    const { rows } = await db.query<AgentRow>(
      `SELECT a.agent_id, a.org_id, a.name, a.type, a.active, a.created_by
         FROM agents a
        WHERE a.org_id = $1
          AND a.active = true
          AND (
            a.type = 'personal'
            OR EXISTS (
              SELECT 1 FROM agent_allowlist al
               WHERE al.agent_id = a.agent_id
                 AND (al.allowed_agent_id = $2 OR al.allowed_agent_id = '*')
            )
          )
        ORDER BY a.type, a.name`,
      [cfg.org, cfg.agentId],
    );
    return rows;
  } catch (err) {
    console.warn("[memory-second-brain] failed to load visible agents:", String(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Agent credentials (per-agent OAuth tokens)
// ---------------------------------------------------------------------------

export interface AgentCredentialRow {
  token_data: string; // AES-256-GCM encrypted JSON
  scopes: string[];
  expires_at: Date | null;
}

export async function getAgentCredential(
  cfg: PluginConfig,
  provider: string,
): Promise<AgentCredentialRow | null> {
  const db = getPool(cfg);
  if (!db) return null;

  try {
    const { rows } = await db.query<AgentCredentialRow>(
      "SELECT token_data, scopes, expires_at FROM agent_credentials WHERE org_id = $1 AND agent_id = $2 AND provider = $3",
      [cfg.org, cfg.agentId, provider],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[memory-second-brain] failed to load agent credential:", String(err));
    return null;
  }
}

export async function saveAgentCredential(
  cfg: PluginConfig,
  provider: string,
  tokenData: string,
  scopes: string[],
  expiresAt: Date | null,
): Promise<void> {
  const db = getPool(cfg);
  if (!db) return;

  await db.query(
    `INSERT INTO agent_credentials (org_id, agent_id, provider, token_data, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, agent_id, provider)
     DO UPDATE SET token_data = $4, scopes = $5, expires_at = $6, updated_at = NOW()`,
    [cfg.org, cfg.agentId, provider, tokenData, scopes, expiresAt],
  );
}

export async function deleteAgentCredential(cfg: PluginConfig, provider: string): Promise<void> {
  const db = getPool(cfg);
  if (!db) return;

  await db.query(
    "DELETE FROM agent_credentials WHERE org_id = $1 AND agent_id = $2 AND provider = $3",
    [cfg.org, cfg.agentId, provider],
  );
}
