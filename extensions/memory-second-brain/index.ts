import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAgentProjects, getSkillSecrets } from "./src/db.js";
import { getAgentCredential, deleteAgentCredential } from "./src/db.js";
import {
  generateGoogleAuthUrl,
  gmailSearch,
  gmailRead,
  calendarList,
  calendarCreate,
  driveSearch,
  driveRead,
} from "./src/google.js";
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
//   - Google tools: connect_google, gmail_search, gmail_read,
//     calendar_list, calendar_create, drive_search, drive_read
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

    // -----------------------------------------------------------------------
    // Google Workspace tools — per-user OAuth tokens from agent_credentials
    // -----------------------------------------------------------------------

    const googleNotConnected = {
      content: [
        {
          type: "text" as const,
          text: "Google não está conectado. Peça ao usuário para conectar usando connect_google.",
        },
      ],
      details: { action: "rejected" as const, reason: "not_connected" },
    };

    function googleError(err: unknown) {
      const msg = String(err);
      // Token revoked or invalid
      if (msg.includes("invalid_grant") || msg.includes("Token has been expired or revoked")) {
        deleteAgentCredential(cfg, "google").catch(() => {});
        return {
          content: [
            {
              type: "text" as const,
              text: "Acesso ao Google foi revogado. Peça ao usuário para reconectar usando connect_google.",
            },
          ],
          details: { action: "error" as const, reason: "token_revoked" },
        };
      }
      return {
        content: [{ type: "text" as const, text: `Google API error: ${msg}` }],
        details: { action: "error" as const, error: msg },
      };
    }

    // Tool: connect_google

    api.registerTool(
      {
        name: "connect_google",
        label: "Connect Google",
        description:
          "Connect the user's Google account (Gmail, Calendar, Drive). " +
          "Generates an authorization link for the user to click. " +
          "Use when the user wants to access their emails, calendar, or Drive files.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          // Check if already connected
          const existing = await getAgentCredential(cfg, "google");
          if (existing) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Google já está conectado! Você pode usar gmail_search, calendar_list e drive_search.",
                },
              ],
              details: { action: "already_connected" },
            };
          }

          const url = generateGoogleAuthUrl(cfg);
          if (!url) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Google OAuth não está configurado. Entre em contato com o administrador.",
                },
              ],
              details: { action: "rejected", reason: "not_configured" },
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Para conectar sua conta Google, clique no link abaixo:\n\n${url}\n\nApós autorizar, volte aqui e peça o que precisar (emails, agenda, documentos).`,
              },
            ],
            details: { action: "auth_url_generated" },
          };
        },
      },
      { name: "connect_google" },
    );

    // Tool: gmail_search

    api.registerTool(
      {
        name: "gmail_search",
        label: "Gmail Search",
        description:
          "Search emails in the user's Gmail. " +
          "Supports Gmail search operators (from:, subject:, after:, before:, is:unread, etc.).",
        parameters: Type.Object(
          {
            query: Type.String({
              description: "Gmail search query (e.g. 'from:boss@company.com is:unread')",
            }),
            maxResults: Type.Optional(
              Type.Number({ description: "Max results (default 5, max 20)" }),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const { query, maxResults: rawMax } = params as { query: string; maxResults?: number };
          const max = Math.min(Math.max(rawMax ?? 5, 1), 20);

          try {
            const results = await gmailSearch(cfg, query, max);
            if (!results) return googleNotConnected;
            if (results.length === 0) {
              return {
                content: [
                  { type: "text" as const, text: `Nenhum email encontrado para: "${query}"` },
                ],
                details: { action: "searched", query, count: 0 },
              };
            }

            const formatted = results
              .map(
                (e) =>
                  `- **${e.subject}**\n  De: ${e.from} | ${e.date}\n  ${e.snippet}\n  [ID: ${e.id}]`,
              )
              .join("\n\n");

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Emails encontrados (${results.length}):\n\n${formatted}`,
                },
              ],
              details: { action: "searched", query, count: results.length },
            };
          } catch (err) {
            return googleError(err);
          }
        },
      },
      { name: "gmail_search" },
    );

    // Tool: gmail_read

    api.registerTool(
      {
        name: "gmail_read",
        label: "Gmail Read",
        description:
          "Read the full content of a specific email by its message ID (from gmail_search results).",
        parameters: Type.Object(
          {
            messageId: Type.String({
              description: "The email message ID (from gmail_search results)",
            }),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const { messageId } = params as { messageId: string };

          try {
            const email = await gmailRead(cfg, messageId);
            if (!email) return googleNotConnected;

            const text = [
              `**${email.subject}**`,
              `De: ${email.from}`,
              `Para: ${email.to}`,
              `Data: ${email.date}`,
              "",
              email.body,
            ].join("\n");

            return {
              content: [{ type: "text" as const, text }],
              details: { action: "read", messageId },
            };
          } catch (err) {
            return googleError(err);
          }
        },
      },
      { name: "gmail_read" },
    );

    // Tool: calendar_list

    api.registerTool(
      {
        name: "calendar_list",
        label: "Calendar List",
        description:
          "List upcoming calendar events. " +
          "Defaults to the next 7 days if no dates are specified.",
        parameters: Type.Object(
          {
            timeMin: Type.Optional(
              Type.String({
                description: "Start date/time (ISO 8601, e.g. '2026-03-05T00:00:00Z')",
              }),
            ),
            timeMax: Type.Optional(Type.String({ description: "End date/time (ISO 8601)" })),
            maxResults: Type.Optional(
              Type.Number({ description: "Max events (default 10, max 50)" }),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const {
            timeMin: rawMin,
            timeMax: rawMax,
            maxResults: rawCount,
          } = params as {
            timeMin?: string;
            timeMax?: string;
            maxResults?: number;
          };

          const now = new Date();
          const timeMin = rawMin ?? now.toISOString();
          const timeMax = rawMax ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
          const maxResults = Math.min(Math.max(rawCount ?? 10, 1), 50);

          try {
            const events = await calendarList(cfg, timeMin, timeMax, maxResults);
            if (!events) return googleNotConnected;
            if (events.length === 0) {
              return {
                content: [{ type: "text" as const, text: "Nenhum evento encontrado no período." }],
                details: { action: "listed", count: 0 },
              };
            }

            const formatted = events
              .map((e) => {
                let line = `- **${e.summary}**\n  ${e.start} → ${e.end}`;
                if (e.location) line += `\n  Local: ${e.location}`;
                if (e.attendees?.length) line += `\n  Participantes: ${e.attendees.join(", ")}`;
                return line;
              })
              .join("\n\n");

            return {
              content: [
                { type: "text" as const, text: `Eventos (${events.length}):\n\n${formatted}` },
              ],
              details: { action: "listed", count: events.length },
            };
          } catch (err) {
            return googleError(err);
          }
        },
      },
      { name: "calendar_list" },
    );

    // Tool: calendar_create

    api.registerTool(
      {
        name: "calendar_create",
        label: "Calendar Create",
        description: "Create a new calendar event.",
        parameters: Type.Object(
          {
            summary: Type.String({ description: "Event title" }),
            start: Type.String({
              description: "Start date/time (ISO 8601, e.g. '2026-03-05T14:00:00-03:00')",
            }),
            end: Type.String({ description: "End date/time (ISO 8601)" }),
            description: Type.Optional(Type.String({ description: "Event description" })),
            location: Type.Optional(Type.String({ description: "Event location" })),
            attendees: Type.Optional(
              Type.Array(Type.String(), { description: "Email addresses of attendees" }),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const p = params as {
            summary: string;
            start: string;
            end: string;
            description?: string;
            location?: string;
            attendees?: string[];
          };

          try {
            const event = await calendarCreate(cfg, p);
            if (!event) return googleNotConnected;

            let text = `Evento criado: **${event.summary}**\n${event.start} → ${event.end}`;
            if (event.htmlLink) text += `\n\n${event.htmlLink}`;

            return {
              content: [{ type: "text" as const, text }],
              details: { action: "created", eventId: event.id },
            };
          } catch (err) {
            return googleError(err);
          }
        },
      },
      { name: "calendar_create" },
    );

    // Tool: drive_search

    api.registerTool(
      {
        name: "drive_search",
        label: "Drive Search",
        description: "Search for files in the user's Google Drive.",
        parameters: Type.Object(
          {
            query: Type.String({ description: "Search query (file name or content)" }),
            maxResults: Type.Optional(
              Type.Number({ description: "Max results (default 10, max 30)" }),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const { query, maxResults: rawMax } = params as { query: string; maxResults?: number };
          const max = Math.min(Math.max(rawMax ?? 10, 1), 30);

          try {
            const files = await driveSearch(cfg, query, max);
            if (!files) return googleNotConnected;
            if (files.length === 0) {
              return {
                content: [
                  { type: "text" as const, text: `Nenhum arquivo encontrado para: "${query}"` },
                ],
                details: { action: "searched", query, count: 0 },
              };
            }

            const formatted = files
              .map((f) => {
                let line = `- **${f.name}** [${f.mimeType}]`;
                if (f.modifiedTime) line += ` (${f.modifiedTime})`;
                if (f.webViewLink) line += `\n  ${f.webViewLink}`;
                line += `\n  [ID: ${f.id}]`;
                return line;
              })
              .join("\n\n");

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Arquivos encontrados (${files.length}):\n\n${formatted}`,
                },
              ],
              details: { action: "searched", query, count: files.length },
            };
          } catch (err) {
            return googleError(err);
          }
        },
      },
      { name: "drive_search" },
    );

    // Tool: drive_read

    api.registerTool(
      {
        name: "drive_read",
        label: "Drive Read",
        description:
          "Read the content of a file from Google Drive. " +
          "Supports Google Docs (text), Sheets (CSV), Slides (text), and plain text files.",
        parameters: Type.Object(
          {
            fileId: Type.String({ description: "The file ID (from drive_search results)" }),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const { fileId } = params as { fileId: string };

          try {
            const result = await driveRead(cfg, fileId);
            if (!result) return googleNotConnected;

            return {
              content: [
                {
                  type: "text" as const,
                  text: `**${result.name}**\n\n${result.content}`,
                },
              ],
              details: { action: "read", fileId, fileName: result.name },
            };
          } catch (err) {
            return googleError(err);
          }
        },
      },
      { name: "drive_read" },
    );
  },
};

export default memorySecondBrainPlugin;
