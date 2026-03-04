import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAgentProjects } from "./src/db.js";
import { loadContext } from "./src/load.js";
import { flushDailyLog, writeMemoryFile } from "./src/save.js";
import { listSkills, writeSkill } from "./src/skills.js";
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
//   - write_skill tool: LLM creates/updates personal skills
//   - list_skills tool: LLM lists available org + personal skills
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

    const MAX_MEMORY_SIZE = 10_000; // 10 KB
    const MAX_WRITES_PER_SESSION = 3;
    let writeCount = 0;

    // Reset write counter on each new session
    api.on("before_agent_start", async () => {
      writeCount = 0;
      return undefined;
    });

    api.registerTool(
      {
        name: "write_memory",
        label: "Write Memory",
        description:
          "Persist important information to long-term memory. " +
          "Use target='memory' for facts, decisions, and patterns worth remembering across sessions. " +
          "Use target='user' to update the user profile with new information. " +
          "Max 10KB per write, max 3 writes per session.",
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

          if (content.length > MAX_MEMORY_SIZE) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Content too large (${content.length} chars, max ${MAX_MEMORY_SIZE}). Trim and retry.`,
                },
              ],
              details: { action: "rejected", reason: "size_limit" },
            };
          }

          if (++writeCount > MAX_WRITES_PER_SESSION) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Write limit reached (max ${MAX_WRITES_PER_SESSION} per session). Memory not updated.`,
                },
              ],
              details: { action: "rejected", reason: "rate_limit" },
            };
          }

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
    // Tool: list_skills — list available org + personal skills
    // -----------------------------------------------------------------------

    api.registerTool(
      {
        name: "list_skills",
        label: "List Skills",
        description:
          "List all available skills (org-level and personal). " +
          "Shows skill name, description, and tier (org or personal).",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          try {
            const skills = await listSkills(cfg);
            if (skills.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No skills available." }],
                details: { action: "listed", count: 0 },
              };
            }

            const lines = skills.map((s) => `- **${s.name}** [${s.tier}]: ${s.description}`);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Available skills (${skills.length}):\n\n${lines.join("\n")}`,
                },
              ],
              details: { action: "listed", count: skills.length },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Failed to list skills: ${String(err)}` }],
              details: { action: "error", error: String(err) },
            };
          }
        },
      },
      { name: "list_skills" },
    );

    // -----------------------------------------------------------------------
    // Tool: write_skill — create/update personal skill
    // -----------------------------------------------------------------------

    api.registerTool(
      {
        name: "write_skill",
        label: "Write Skill",
        description:
          "Create or update a personal skill. Skills are reusable instructions " +
          "that teach you how to perform specific tasks. " +
          "The content must be valid SKILL.md with YAML frontmatter (name + description). " +
          "Max 50KB per skill, max 10 personal skills.",
        parameters: Type.Object(
          {
            name: Type.String({
              description:
                "Skill name: lowercase letters, numbers, and hyphens only (2-64 chars). " +
                "Example: 'email-template', 'code-review'",
            }),
            content: Type.String({
              description:
                "Full SKILL.md content including YAML frontmatter with 'name' and 'description'",
            }),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const { name, content } = params as { name: string; content: string };

          try {
            const result = await writeSkill(cfg, name, content);
            return {
              content: [{ type: "text" as const, text: result.message }],
              details: {
                action: result.ok ? "written" : "rejected",
                skillName: name,
                path: result.path,
              },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to write skill "${name}": ${String(err)}`,
                },
              ],
              details: { action: "error", error: String(err) },
            };
          }
        },
      },
      { name: "write_skill" },
    );
  },
};

export default memorySecondBrainPlugin;
