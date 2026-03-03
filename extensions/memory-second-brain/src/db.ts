import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PluginConfig, SessionTurn } from "./types.js";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let supabase: SupabaseClient | null = null;

export function getSupabase(cfg: PluginConfig): SupabaseClient | null {
  if (!cfg.supabaseUrl || !cfg.supabaseKey) return null;
  if (!supabase) {
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      db: { schema: "public" },
    });
  }
  return supabase;
}

// ---------------------------------------------------------------------------
// Project membership
// ---------------------------------------------------------------------------

export async function getAgentProjects(cfg: PluginConfig): Promise<string[]> {
  const db = getSupabase(cfg);
  if (!db) return [];

  const { data, error } = await db
    .from("project_members")
    .select("project_id")
    .eq("org_id", cfg.org)
    .eq("agent_id", cfg.agentId);

  if (error) {
    console.warn("[memory-second-brain] failed to load projects:", error.message);
    return [];
  }

  return (data ?? []).map((row) => row.project_id as string);
}

// ---------------------------------------------------------------------------
// Session persistence (for recovery after container restart)
// ---------------------------------------------------------------------------

export async function persistSession(
  cfg: PluginConfig,
  sessionId: string,
  turns: SessionTurn[],
): Promise<void> {
  const db = getSupabase(cfg);
  if (!db || turns.length === 0) return;

  const { error } = await db.from("sessions").upsert(
    {
      session_id: sessionId,
      org_id: cfg.org,
      agent_id: cfg.agentId,
      turns: JSON.stringify(turns),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" },
  );

  if (error) {
    console.warn("[memory-second-brain] failed to persist session:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Session recovery — load recent turns if container restarted within window
// ---------------------------------------------------------------------------

export async function loadRecentSession(
  cfg: PluginConfig,
  sessionId: string,
  maxAgeMinutes = 30,
): Promise<SessionTurn[]> {
  const db = getSupabase(cfg);
  if (!db) return [];

  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("sessions")
    .select("turns, updated_at")
    .eq("session_id", sessionId)
    .eq("org_id", cfg.org)
    .eq("agent_id", cfg.agentId)
    .gte("updated_at", cutoff)
    .single();

  if (error || !data) return [];

  try {
    return JSON.parse(data.turns as string) as SessionTurn[];
  } catch {
    return [];
  }
}
