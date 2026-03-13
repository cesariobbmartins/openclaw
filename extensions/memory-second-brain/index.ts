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
import { writeUserFile } from "./src/save.js";
import { listSkills, writeSkill } from "./src/skills.js";
import type { PluginConfig } from "./src/types.js";

// ---------------------------------------------------------------------------
// Plugin — enterprise extensions for Second Brain agents
//
// Multi-agent aware: tools use OpenClawPluginToolFactory pattern so agentId
// is resolved at runtime from the request context (not static config).
// This allows a single OpenClaw process to serve multiple agents.
//
// What OpenClaw handles natively (we don't touch):
//   - SOUL.md, USER.md, MEMORY.md, IDENTITY.md reading + system prompt injection
//   - Session persistence via JSONL on disk (serves as audit trail)
//
// What this plugin adds:
//   - Org context: STRATEGY.md, CULTURE.md
//   - Project context: CONTEXT.md per project membership
//   - write_user tool: LLM updates USER.md (always-on user profile)
//   - write_skill tool: LLM creates/updates personal skills
//   - list_skills tool: LLM lists available org + personal skills
//   - Tag context: TAGS.md injected via prependContext for tag consistency
//   - web_search tool: search the web via Brave Search (key from skill_secrets)
//   - browse_url tool: read a web page via Jina Reader API (returns markdown)
//   - Google tools: connect_google, gmail_search, gmail_read,
//     calendar_list, calendar_create, drive_search, drive_read
// ---------------------------------------------------------------------------

const memorySecondBrainPlugin = {
  id: "memory-second-brain",
  name: "Second Brain Enterprise",
  description:
    "Enterprise extensions: org context, user profile, skills, web, and Google integrations",

  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig as Record<string, unknown>;

    // Base config from static plugin config. agentId is optional here —
    // in multi-agent mode it comes from runtime context instead.
    const baseCfg = {
      org: raw.org as string,
      agentId: (raw.agentId as string | undefined) ?? "",
      workspacePath: (raw.workspacePath as string | undefined) ?? "/workspaces",
      databaseUrl: raw.databaseUrl as string | undefined,
    };

    api.logger.info(
      `[memory-second-brain] initialized — org=${baseCfg.org} agent=${baseCfg.agentId || "(multi-agent)"}`,
    );

    // -----------------------------------------------------------------------
    // Helpers: build PluginConfig from runtime context
    // -----------------------------------------------------------------------

    function cfgFromCtx(ctx: { agentId?: string }): PluginConfig {
      const agentId = ctx.agentId ?? baseCfg.agentId;
      if (!agentId) {
        throw new Error(
          "[memory-second-brain] SECURITY: agentId is empty. " +
            "In multi-agent mode, ctx.agentId must be set by the request handler.",
        );
      }
      return {
        org: baseCfg.org,
        agentId,
        workspacePath: baseCfg.workspacePath,
        databaseUrl: baseCfg.databaseUrl,
      };
    }

    // -----------------------------------------------------------------------
    // Per-agent state (Maps keyed by agentId for multi-agent isolation)
    // -----------------------------------------------------------------------

    const writeCountMap = new Map<string, number>();
    const skillSecretsMap = new Map<string, Map<string, Map<string, string>>>();
    const skillSecretsLoaded = new Set<string>();

    const MAX_USER_SIZE = 10_000; // 10 KB
    const MAX_WRITES_PER_SESSION = 3;
    const MAX_BROWSE_CONTENT = 12_000;

    async function ensureSkillSecrets(
      cfg: PluginConfig,
    ): Promise<Map<string, Map<string, string>>> {
      const key = cfg.agentId;
      if (!skillSecretsLoaded.has(key)) {
        try {
          const secrets = await getSkillSecrets(cfg);
          skillSecretsMap.set(key, secrets);
          skillSecretsLoaded.add(key);
        } catch (err) {
          api.logger.warn(`[memory-second-brain] skill secrets (${key}): ${String(err)}`);
        }
      }
      return skillSecretsMap.get(key) ?? new Map();
    }

    // -----------------------------------------------------------------------
    // Google helpers
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

    function googleError(cfg: PluginConfig, err: unknown) {
      const msg = String(err);
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

    // -----------------------------------------------------------------------
    // Hook: before_agent_start — inject org + project context
    // -----------------------------------------------------------------------

    api.on("before_agent_start", async (_event, ctx) => {
      const cfg = cfgFromCtx(ctx);
      try {
        const projectIds = await getAgentProjects(cfg);
        const extensionContext = await loadContext(cfg, projectIds);

        if (!extensionContext) return undefined;
        return { prependContext: extensionContext };
      } catch (err) {
        api.logger.warn(`[memory-second-brain] load failed (${cfg.agentId}): ${String(err)}`);
        return undefined;
      }
    });

    // Reset write counter on each new session
    api.on("before_agent_start", async (_event, ctx) => {
      const cfg = cfgFromCtx(ctx); // validates agentId
      writeCountMap.set(cfg.agentId, 0);
      return undefined;
    });

    // Load skill secrets (Google token no longer written to process.env —
    // each tool fetches its own token via getGoogleClient(cfg) per-request)
    api.on("before_agent_start", async (_event, ctx) => {
      const cfg = cfgFromCtx(ctx);

      // SECURITY: always clear process-wide env var to prevent cross-agent leakage
      delete process.env.GOOGLE_WORKSPACE_CLI_TOKEN;

      await ensureSkillSecrets(cfg);

      return undefined;
    });

    // -----------------------------------------------------------------------
    // Tool: write_user — LLM updates USER.md (always-on user profile)
    // -----------------------------------------------------------------------

    api.registerTool(
      (ctx) => ({
        name: "write_user",
        label: "Write User Profile",
        description:
          "Update the user profile (USER.md) with new information about the user. " +
          "This file is always present in your context, so use it for information " +
          "that must be available in every interaction: name, preferences, language, " +
          "communication style, important personal details. " +
          "Max 10KB per write, max 3 writes per session.",
        parameters: Type.Object(
          {
            content: Type.String({
              description: "Full markdown content to write to USER.md (replaces existing content)",
            }),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const cfg = cfgFromCtx(ctx);
          const { content } = params as { content: string };

          if (content.length > MAX_USER_SIZE) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Content too large (${content.length} chars, max ${MAX_USER_SIZE}). Trim and retry.`,
                },
              ],
              details: { action: "rejected", reason: "size_limit" },
            };
          }

          const count = (writeCountMap.get(cfg.agentId) ?? 0) + 1;
          writeCountMap.set(cfg.agentId, count);
          if (count > MAX_WRITES_PER_SESSION) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Write limit reached (max ${MAX_WRITES_PER_SESSION} per session). Profile not updated.`,
                },
              ],
              details: { action: "rejected", reason: "rate_limit" },
            };
          }

          try {
            await writeUserFile(cfg, content);
            return {
              content: [{ type: "text" as const, text: "USER.md updated successfully." }],
              details: { action: "written", filename: "USER.md" },
            };
          } catch (err) {
            return {
              content: [
                { type: "text" as const, text: `Failed to update user profile: ${String(err)}` },
              ],
              details: { action: "error", error: String(err) },
            };
          }
        },
      }),
      { name: "write_user" },
    );

    // -----------------------------------------------------------------------
    // Tool: list_skills — list available org + personal skills
    // -----------------------------------------------------------------------

    api.registerTool(
      (ctx) => ({
        name: "list_skills",
        label: "List Skills",
        description:
          "List all available skills (org-level and personal). " +
          "Shows skill name, description, and tier (org or personal).",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          const cfg = cfgFromCtx(ctx);
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
      }),
      { name: "list_skills" },
    );

    // -----------------------------------------------------------------------
    // Tool: write_skill — create/update personal skill
    // -----------------------------------------------------------------------

    api.registerTool(
      (ctx) => ({
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
          const cfg = cfgFromCtx(ctx);
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
      }),
      { name: "write_skill" },
    );

    // -----------------------------------------------------------------------
    // Tool: web_search — search the web via Brave Search API
    // -----------------------------------------------------------------------

    api.registerTool(
      (ctx) => ({
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
          const cfg = cfgFromCtx(ctx);
          const { query, count: rawCount } = params as { query: string; count?: number };
          const count = Math.min(Math.max(rawCount ?? 5, 1), 10);

          const secrets = await ensureSkillSecrets(cfg);
          const braveSecrets = secrets.get("brave-search");
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
      }),
      { name: "web_search" },
    );

    // -----------------------------------------------------------------------
    // Tool: browse_url — read a web page via Jina Reader API
    // -----------------------------------------------------------------------

    api.registerTool(
      (ctx) => ({
        name: "browse_url",
        label: "Browse URL",
        description:
          "Navigate to a URL and extract the page content as markdown. " +
          "Handles JavaScript-rendered pages (SPAs). " +
          "Use when you need to read a web page, article, or documentation. " +
          "For search, prefer web_search instead.",
        parameters: Type.Object(
          {
            url: Type.String({ description: "The URL to navigate to" }),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const cfg = cfgFromCtx(ctx);
          const { url } = params as { url: string };
          const secrets = await ensureSkillSecrets(cfg);
          const jinaKey = secrets.get("jina")?.get("JINA_API_KEY");

          try {
            const headers: Record<string, string> = { Accept: "text/markdown" };
            if (jinaKey) headers["Authorization"] = `Bearer ${jinaKey}`;

            const res = await fetch(`https://r.jina.ai/${url}`, {
              headers,
              signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            let content = await res.text();
            if (content.length > MAX_BROWSE_CONTENT) {
              content = content.slice(0, MAX_BROWSE_CONTENT) + "\n\n[... truncado]";
            }

            return {
              content: [{ type: "text" as const, text: content }],
              details: { action: "browsed", url },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Falha ao abrir ${url}: ${String(err)}` }],
              details: { action: "error" },
            };
          }
        },
      }),
      { name: "browse_url" },
    );

    // -----------------------------------------------------------------------
    // Google Workspace tools — per-user OAuth tokens from agent_credentials
    // -----------------------------------------------------------------------

    // Tool: connect_google

    api.registerTool(
      (ctx) => ({
        name: "connect_google",
        label: "Connect Google",
        description:
          "Connect the user's Google account (Gmail, Calendar, Drive). " +
          "Generates an authorization link for the user to click. " +
          "Use when the user wants to access their emails, calendar, or Drive files.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          const cfg = cfgFromCtx(ctx);

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

          // Prefer short Hub redirect URL (avoids WhatsApp truncation)
          const hubUrl = process.env.HUB_URL;
          let url: string | null = null;
          if (hubUrl) {
            url = `${hubUrl}/oauth/google/start?org=${encodeURIComponent(cfg.org)}&agent=${encodeURIComponent(cfg.agentId)}`;
          } else {
            url = generateGoogleAuthUrl(cfg);
          }

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
      }),
      { name: "connect_google" },
    );

    // Tool: gmail_search

    api.registerTool(
      (ctx) => ({
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
          const cfg = cfgFromCtx(ctx);
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
            return googleError(cfg, err);
          }
        },
      }),
      { name: "gmail_search" },
    );

    // Tool: gmail_read

    api.registerTool(
      (ctx) => ({
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
          const cfg = cfgFromCtx(ctx);
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
            return googleError(cfg, err);
          }
        },
      }),
      { name: "gmail_read" },
    );

    // Tool: calendar_list

    api.registerTool(
      (ctx) => ({
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
          const cfg = cfgFromCtx(ctx);
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
            return googleError(cfg, err);
          }
        },
      }),
      { name: "calendar_list" },
    );

    // Tool: calendar_create

    api.registerTool(
      (ctx) => ({
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
          const cfg = cfgFromCtx(ctx);
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
            return googleError(cfg, err);
          }
        },
      }),
      { name: "calendar_create" },
    );

    // Tool: drive_search

    api.registerTool(
      (ctx) => ({
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
          const cfg = cfgFromCtx(ctx);
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
            return googleError(cfg, err);
          }
        },
      }),
      { name: "drive_search" },
    );

    // Tool: drive_read

    api.registerTool(
      (ctx) => ({
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
          const cfg = cfgFromCtx(ctx);
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
            return googleError(cfg, err);
          }
        },
      }),
      { name: "drive_read" },
    );
  },
};

export default memorySecondBrainPlugin;
