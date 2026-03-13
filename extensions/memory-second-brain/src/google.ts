import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { encrypt, decrypt, generateOAuthState } from "./crypto.js";
import { getAgentCredential, saveAgentCredential, deleteAgentCredential } from "./db.js";
import type { PluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenData {
  access_token: string;
  refresh_token: string;
  expiry_date: number | null;
}

export interface EmailResult {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

export interface EmailContent {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
  htmlLink?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly", // read-only
  "https://www.googleapis.com/auth/calendar", // read + write (create events)
  "https://www.googleapis.com/auth/drive.readonly", // read-only
  "https://www.googleapis.com/auth/documents.readonly", // read-only
  "https://www.googleapis.com/auth/spreadsheets.readonly", // read-only
  "https://www.googleapis.com/auth/tasks.readonly", // read-only
  "https://www.googleapis.com/auth/contacts.readonly", // read-only
  "https://www.googleapis.com/auth/meetings.space.readonly", // read-only
];

// ---------------------------------------------------------------------------
// OAuth URL generation
// ---------------------------------------------------------------------------

export function generateGoogleAuthUrl(cfg: PluginConfig): string | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const stateSecret = process.env.OAUTH_STATE_SECRET;

  if (!clientId || !redirectUri || !stateSecret) return null;

  const oauth2 = new OAuth2Client(clientId, undefined, redirectUri);
  const state = generateOAuthState(cfg.org, cfg.agentId, stateSecret);

  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: GOOGLE_SCOPES,
    state,
    prompt: "consent",
  });
}

// ---------------------------------------------------------------------------
// Google client factory
// ---------------------------------------------------------------------------

async function getGoogleClient(
  cfg: PluginConfig,
): Promise<{ oauth2: OAuth2Client; tokenData: TokenData } | null> {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) return null;

  const cred = await getAgentCredential(cfg, "google");
  if (!cred) return null;

  let tokenData: TokenData;
  try {
    tokenData = JSON.parse(decrypt(cred.token_data, encryptionKey));
  } catch {
    console.warn("[google] Failed to decrypt credentials — deleting stale entry");
    await deleteAgentCredential(cfg, "google");
    return null;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret) return null;

  const oauth2 = new OAuth2Client(clientId, clientSecret, redirectUri);
  // Force native fetch — root gaxios may resolve to node-fetch which fails
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (oauth2 as any).transporter.defaults.fetchImplementation = globalThis.fetch;
  oauth2.setCredentials({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry_date: tokenData.expiry_date,
  });

  // Persist refreshed tokens
  oauth2.on("tokens", (tokens) => {
    const updated: TokenData = {
      access_token: tokens.access_token ?? tokenData.access_token,
      refresh_token: tokens.refresh_token ?? tokenData.refresh_token,
      expiry_date: tokens.expiry_date ?? tokenData.expiry_date,
    };
    const encrypted = encrypt(JSON.stringify(updated), encryptionKey);
    const expiresAt = updated.expiry_date ? new Date(updated.expiry_date) : null;
    saveAgentCredential(cfg, "google", encrypted, GOOGLE_SCOPES, expiresAt).catch((err) => {
      console.warn("[google] Failed to persist refreshed tokens:", String(err));
    });
  });

  return { oauth2, tokenData };
}

// ---------------------------------------------------------------------------
// Access token for external CLIs (gws)
// ---------------------------------------------------------------------------

/**
 * Return a fresh Google OAuth access token for use by external tools (e.g. gws CLI).
 * Returns null if the user hasn't connected Google yet.
 */
export async function getGoogleAccessToken(cfg: PluginConfig): Promise<string | null> {
  const client = await getGoogleClient(cfg);
  if (!client) return null;

  const { token } = await client.oauth2.getAccessToken();
  return token ?? null;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export async function gmailSearch(
  cfg: PluginConfig,
  query: string,
  maxResults: number,
): Promise<EmailResult[] | null> {
  const client = await getGoogleClient(cfg);
  if (!client) return null;

  const gmail = google.gmail({ version: "v1", auth: client.oauth2 });
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const messages = res.data.messages ?? [];
  const results: EmailResult[] = [];

  for (const msg of messages.slice(0, maxResults)) {
    if (!msg.id) continue;
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers = detail.data.payload?.headers ?? [];
    results.push({
      id: msg.id,
      from: headers.find((h) => h.name === "From")?.value ?? "",
      subject: headers.find((h) => h.name === "Subject")?.value ?? "(sem assunto)",
      snippet: detail.data.snippet ?? "",
      date: headers.find((h) => h.name === "Date")?.value ?? "",
    });
  }

  return results;
}

export async function gmailRead(
  cfg: PluginConfig,
  messageId: string,
): Promise<EmailContent | null> {
  const client = await getGoogleClient(cfg);
  if (!client) return null;

  const gmail = google.gmail({ version: "v1", auth: client.oauth2 });
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = res.data.payload?.headers ?? [];
  const from = headers.find((h) => h.name === "From")?.value ?? "";
  const to = headers.find((h) => h.name === "To")?.value ?? "";
  const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
  const date = headers.find((h) => h.name === "Date")?.value ?? "";

  // Extract body (prefer text/plain)
  let body = "";
  const payload = res.data.payload;
  if (payload) {
    const textPart = findPart(payload, "text/plain") ?? findPart(payload, "text/html");
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, "base64url").toString("utf8");
      // Strip HTML tags if we got text/html
      if (textPart.mimeType === "text/html") {
        body = body
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }

  // Truncate very long emails
  if (body.length > 5000) {
    body = body.slice(0, 5000) + "\n\n[...truncado]";
  }

  return { id: messageId, from, to, subject, date, body };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findPart(payload: any, mimeType: string): any {
  if (payload.mimeType === mimeType) return payload;
  for (const part of payload.parts ?? []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export async function calendarList(
  cfg: PluginConfig,
  timeMin: string,
  timeMax: string,
  maxResults: number,
): Promise<CalendarEvent[] | null> {
  const client = await getGoogleClient(cfg);
  if (!client) return null;

  const calendar = google.calendar({ version: "v3", auth: client.oauth2 });
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items ?? []).map((e) => ({
    id: e.id ?? "",
    summary: e.summary ?? "(sem título)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location ?? undefined,
    description: e.description ?? undefined,
    attendees: e.attendees?.map((a) => a.email ?? "").filter(Boolean),
    htmlLink: e.htmlLink ?? undefined,
  }));
}

export async function calendarCreate(
  cfg: PluginConfig,
  params: {
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
  },
): Promise<CalendarEvent | null> {
  const client = await getGoogleClient(cfg);
  if (!client) return null;

  const calendar = google.calendar({ version: "v3", auth: client.oauth2 });
  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: params.summary,
      start: { dateTime: params.start },
      end: { dateTime: params.end },
      description: params.description,
      location: params.location,
      attendees: params.attendees?.map((email) => ({ email })),
    },
  });

  return {
    id: res.data.id ?? "",
    summary: res.data.summary ?? "",
    start: res.data.start?.dateTime ?? res.data.start?.date ?? "",
    end: res.data.end?.dateTime ?? res.data.end?.date ?? "",
    location: res.data.location ?? undefined,
    htmlLink: res.data.htmlLink ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

export async function driveSearch(
  cfg: PluginConfig,
  query: string,
  maxResults: number,
): Promise<DriveFile[] | null> {
  const client = await getGoogleClient(cfg);
  if (!client) return null;

  const drive = google.drive({ version: "v3", auth: client.oauth2 });
  const res = await drive.files.list({
    q: `fullText contains '${query.replace(/'/g, "\\'")}'`,
    pageSize: maxResults,
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
    orderBy: "modifiedTime desc",
  });

  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    webViewLink: f.webViewLink ?? undefined,
    modifiedTime: f.modifiedTime ?? undefined,
  }));
}

export async function driveRead(
  cfg: PluginConfig,
  fileId: string,
): Promise<{ name: string; content: string } | null> {
  const client = await getGoogleClient(cfg);
  if (!client) return null;

  const drive = google.drive({ version: "v3", auth: client.oauth2 });

  // Get file metadata
  const meta = await drive.files.get({ fileId, fields: "name,mimeType" });
  const name = meta.data.name ?? fileId;
  const mimeType = meta.data.mimeType ?? "";

  let content: string;

  if (mimeType === "application/vnd.google-apps.document") {
    // Google Docs → export as plain text
    const res = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    content = String(res.data);
  } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
    // Google Sheets → export as CSV
    const res = await drive.files.export(
      { fileId, mimeType: "text/csv" },
      { responseType: "text" },
    );
    content = String(res.data);
  } else if (mimeType === "application/vnd.google-apps.presentation") {
    // Google Slides → export as plain text
    const res = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    content = String(res.data);
  } else if (mimeType.startsWith("text/")) {
    // Plain text files → download directly
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    content = String(res.data);
  } else {
    content = `[Arquivo binário: ${mimeType}. Use o link no Drive para visualizar.]`;
  }

  // Truncate very long content
  if (content.length > 10000) {
    content = content.slice(0, 10000) + "\n\n[...truncado]";
  }

  return { name, content };
}
