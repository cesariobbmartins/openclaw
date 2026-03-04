import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAgentProjects, getSkillSecrets } from "./src/db.js";
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
//   - web_search tool: search the web via Brave Search (key from skill_secrets)
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

    // -----------------------------------------------------------------------
    // Tool: web_search — search the web via Brave Search API
    // API key loaded from skill_secrets table, never exposed to LLM
    // -----------------------------------------------------------------------

    let skillSecrets: Map<string, Map<string, string>> = new Map();

    api.on("before_agent_start", async () => {
      try {
        skillSecrets = await getSkillSecrets(cfg);
      } catch (err) {
        api.logger.warn(`[memory-second-brain] failed to load skill secrets: ${String(err)}`);
      }
      return undefined;
    });

    api.registerTool(
      {
        name: "web_search",
        label: "Web Search",
        description:
          "Search the web for current information using Brave Search. " +
          "Returns titles, URLs, and snippets for the top results. " +
          "Use when the user asks about recent events, needs factual lookups, " +
          "or wants information beyond your training data.",
        parameters: Type.Object(
          {
            query: Type.String({
              description: "The search query",
            }),
            count: Type.Optional(
              Type.Number({
                description: "Number of results to return (default 5, max 10)",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const { query, count: rawCount } = params as { query: string; count?: number };
          const count = Math.min(Math.max(rawCount ?? 5, 1), 10);

          const braveSecrets = skillSecrets.get("brave-search");
          const apiKey = braveSecrets?.get("BRAVE_API_KEY");

          if (!apiKey) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Web search is not configured. The BRAVE_API_KEY secret is missing from skill_secrets.",
                },
              ],
              details: { action: "rejected", reason: "missing_secret" },
            };
          }

          try {
            const url = new URL("https://api.search.brave.com/res/v1/web/search");
            url.searchParams.set("q", query);
            url.searchParams.set("count", String(count));

            const res = await fetch(url.toString(), {
              headers: {
                Accept: "application/json",
                "X-Subscription-Token": apiKey,
              },
            });

            if (!res.ok) {
              const body = await res.text().catch(() => "");
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Brave Search API error (${res.status}): ${body.slice(0, 200)}`,
                  },
                ],
                details: { action: "error", status: res.status },
              };
            }

            const data = (await res.json()) as {
              web?: {
                results?: Array<{
                  title?: string;
                  url?: string;
                  description?: string;
                }>;
              };
            };

            const results = data.web?.results ?? [];
            if (results.length === 0) {
              return {
                content: [{ type: "text" as const, text: `No results found for: "${query}"` }],
                details: { action: "searched", query, count: 0 },
              };
            }

            const formatted = results
              .map(
                (r, i) =>
                  `${i + 1}. **${r.title ?? "Untitled"}**\n   ${r.url ?? ""}\n   ${r.description ?? ""}`,
              )
              .join("\n\n");

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Search results for "${query}":\n\n${formatted}`,
                },
              ],
              details: { action: "searched", query, count: results.length },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Web search failed: ${String(err)}` }],
              details: { action: "error", error: String(err) },
            };
          }
        },
      },
      { name: "web_search" },
    );
  },
};

export default memorySecondBrainPlugin;
