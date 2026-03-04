import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAgentProjects } from "./src/db.js";
import { loadContext } from "./src/load.js";
import { flushDailyLog, writeMemoryFile } from "./src/save.js";
import type { PluginConfig } from "./src/types.js";

// ---------------------------------------------------------------------------
// Plugin — extends OpenClaw native memory with org, project, and daily log
//
// What OpenClaw handles natively (we don't touch):
//   - SOUL.md, USER.md, MEMORY.md, IDENTITY.md reading + system prompt injection
//   - RAG via memory_search / memory_get
//   - Session persistence via JSONL on disk
//
// What this plugin adds:
//   - Org context: STRATEGY.md, CULTURE.md
//   - Project context: CONTEXT.md per project membership
//   - Daily log: append conversations to daily/YYYY-MM-DD.md
//   - write_memory tool: LLM writes MEMORY.md/USER.md at workspace root
//     (where OpenClaw reads and RAG indexes)
// ---------------------------------------------------------------------------

const memorySecondBrainPlugin = {
  id: "memory-second-brain",
  name: "Memory (Second Brain)",
  description: "Extends OpenClaw with org context, project context, daily log, and write_memory",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig as Record<string, unknown>;
    const cfg: PluginConfig = {
      org: raw.org as string,
      agentId: raw.agentId as string,
      workspacePath: (raw.workspacePath as string | undefined) ?? "/workspaces",
      databaseUrl: raw.databaseUrl as string | undefined,
      dailyTailLines: (raw.dailyTailLines as number | undefined) ?? 100,
    };

    api.logger.info(`[memory-second-brain] initialized — org=${cfg.org} agent=${cfg.agentId}`);

    // -----------------------------------------------------------------------
    // Hook: before_agent_start — inject org + project context + daily tail
    // -----------------------------------------------------------------------

    api.on("before_agent_start", async () => {
      try {
        const projectIds = await getAgentProjects(cfg);
        const extensionContext = await loadContext(cfg, projectIds);

        if (!extensionContext) return undefined;
        return { prependContext: extensionContext };
      } catch (err) {
        api.logger.warn(`[memory-second-brain] load failed: ${String(err)}`);
        return undefined;
      }
    });

    // -----------------------------------------------------------------------
    // Hook: agent_end — append conversation to daily log
    // -----------------------------------------------------------------------

    api.on("agent_end", async (event) => {
      if (!event.success || !event.messages || event.messages.length === 0) return;

      const turns: Array<{ role: string; content: string; timestamp: string }> = [];

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
          turns.push({
            role,
            content: content.trim(),
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Fire-and-forget — don't block agent response
      flushDailyLog(cfg, turns).catch((err) => {
        api.logger.warn(`[memory-second-brain] daily log flush failed: ${String(err)}`);
      });
    });

    // -----------------------------------------------------------------------
    // Tool: write_memory — LLM writes MEMORY.md or USER.md at workspace root
    // (where OpenClaw natively reads and RAG indexes)
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
  },
};

export default memorySecondBrainPlugin;
