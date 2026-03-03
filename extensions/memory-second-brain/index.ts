import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAgentProjects, loadRecentSession } from "./src/db.js";
import { loadContext } from "./src/load.js";
import { flushSession, writeMemoryFile } from "./src/save.js";
import type { PluginConfig, SessionTurn } from "./src/types.js";

// ---------------------------------------------------------------------------
// In-memory session buffer (turns accumulate here during the conversation)
// ---------------------------------------------------------------------------

let sessionTurns: SessionTurn[] = [];
let resolvedCfg: PluginConfig | null = null;
let resolvedSessionId: string | null = null;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const memorySecondBrainPlugin = {
  id: "memory-second-brain",
  name: "Memory (Second Brain)",
  description: "Three-space memory over GCS FUSE: private, org, and projects",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // Resolve and validate config from openclaw.plugin.json configSchema
    const raw = api.pluginConfig as Record<string, unknown>;
    const cfg: PluginConfig = {
      org: raw.org as string,
      agentId: raw.agentId as string,
      workspacePath: (raw.workspacePath as string | undefined) ?? "/workspaces",
      supabaseUrl: raw.supabaseUrl as string | undefined,
      supabaseKey: raw.supabaseKey as string | undefined,
      dailyTailLines: (raw.dailyTailLines as number | undefined) ?? 100,
    };
    resolvedCfg = cfg;

    api.logger.info(
      `[memory-second-brain] initialized — org=${cfg.org} agent=${cfg.agentId} workspace=${cfg.workspacePath}`,
    );

    // -----------------------------------------------------------------------
    // Hook: before_agent_start — load full memory context + session recovery
    // -----------------------------------------------------------------------

    api.on("before_agent_start", async (event) => {
      // session key is the phone number (WhatsApp) or user identifier
      const sessionId =
        (event as { sessionKey?: string }).sessionKey ?? `${cfg.org}/${cfg.agentId}`;
      resolvedSessionId = sessionId;

      try {
        // Load project membership from Supabase
        const projectIds = await getAgentProjects(cfg);

        // Load all memory files from GCS FUSE
        const memoryContext = await loadContext(cfg, projectIds);

        // Session recovery: if container restarted recently, reload prior turns
        const priorTurns = await loadRecentSession(cfg, sessionId, 30);
        if (priorTurns.length > 0) {
          sessionTurns = priorTurns;
          api.logger.info(
            `[memory-second-brain] recovered ${priorTurns.length} turns from Supabase`,
          );
        } else {
          sessionTurns = [];
        }

        if (!memoryContext) return undefined;

        return { prependContext: memoryContext };
      } catch (err) {
        api.logger.warn(`[memory-second-brain] load failed: ${String(err)}`);
        return undefined;
      }
    });

    // -----------------------------------------------------------------------
    // Hook: agent_end — collect turns + flush to GCS + Supabase
    // -----------------------------------------------------------------------

    api.on("agent_end", async (event) => {
      if (!event.success || !event.messages || event.messages.length === 0) return;

      // Extract user + assistant turns from this conversation
      const newTurns: SessionTurn[] = [];
      for (const msg of event.messages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        const role = m.role as string | undefined;
        if (role !== "user" && role !== "assistant") continue;

        let content = "";
        if (typeof m.content === "string") {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          content = (m.content as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("\n");
        }

        if (content.trim()) {
          newTurns.push({
            role: role as "user" | "assistant",
            content: content.trim(),
            timestamp: new Date().toISOString(),
          });
        }
      }

      sessionTurns = [...sessionTurns, ...newTurns];

      // Fire-and-forget flush — don't block agent response
      const sessionId = resolvedSessionId ?? `${cfg.org}/${cfg.agentId}`;
      flushSession(cfg, sessionId, sessionTurns).catch((err) => {
        api.logger.warn(`[memory-second-brain] flush failed: ${String(err)}`);
      });
    });

    // -----------------------------------------------------------------------
    // Tool: write_memory — LLM calls this to update MEMORY.md or USER.md
    // -----------------------------------------------------------------------

    api.registerTool(
      {
        name: "write_memory",
        label: "Write Memory",
        description:
          "Persist important information to long-term memory. " +
          "Use target='memory' for facts, decisions, and patterns worth remembering across sessions. " +
          "Use target='user' to update the user profile with new information.",
        parameters: Type.Object(
          {
            target: Type.Union([Type.Literal("memory"), Type.Literal("user")], {
              description: "'memory' updates MEMORY.md, 'user' updates USER.md",
            }),
            content: Type.String({
              description: "Full markdown content to write to the file (replaces existing content)",
            }),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const { target, content } = params as { target: "memory" | "user"; content: string };
          try {
            await writeMemoryFile(cfg, target, content);
            const filename = target === "memory" ? "MEMORY.md" : "USER.md";
            return {
              content: [{ type: "text" as const, text: `${filename} updated successfully.` }],
              details: { action: "written", target, filename },
            };
          } catch (err) {
            return {
              content: [
                { type: "text" as const, text: `Failed to write ${target}: ${String(err)}` },
              ],
              details: { action: "error", error: String(err) },
            };
          }
        },
      },
      { name: "write_memory" },
    );

    // -----------------------------------------------------------------------
    // Graceful shutdown: flush session before container dies
    // -----------------------------------------------------------------------

    api.registerService({
      id: "memory-second-brain",
      start: () => {
        process.on("SIGTERM", () => {
          if (!resolvedCfg || sessionTurns.length === 0) return;
          const sessionId = resolvedSessionId ?? `${resolvedCfg.org}/${resolvedCfg.agentId}`;
          flushSession(resolvedCfg, sessionId, sessionTurns).catch(() => {});
        });
        api.logger.info("[memory-second-brain] service started");
      },
      stop: () => {
        api.logger.info("[memory-second-brain] service stopped");
      },
    });
  },
};

export default memorySecondBrainPlugin;
