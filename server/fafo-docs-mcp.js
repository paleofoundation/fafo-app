/**
 * FAFO Docs MCP Server v1.0.4
 * Paleo Certified, Inc. dba The Paleo Foundation
 *
 * Creates brand-formatted Google Docs from HTML, matching the CP License
 * Agreement visual style (navy Georgia headings, slate H3, Calibri body,
 * grey divider rules).
 *
 * AUTH (v1.0.4): Authenticates via a stored Google OAuth refresh token for
 * the owner account (jinthemad@gmail.com), minting fresh access tokens on
 * each call. Files are owned by and charged to the user's own Drive quota,
 * so the service account never needs Drive storage of its own. This resolved
 * the persistent "service account Drive quota exceeded" problem at the root.
 *
 * Env vars on Cloud Run:
 *   GOOGLE_REFRESH_TOKEN       — long-lived refresh token (owner consent)
 *   GOOGLE_OAUTH_CLIENT_ID     — Web OAuth client ID
 *   GOOGLE_OAUTH_CLIENT_SECRET — Web OAuth client secret
 *   CASES_FOLDER_ID            — default Drive folder
 *   QUOTA_PROJECT              — GCP project for quota attribution
 *
 * Auth precedence in getClients():
 *   1. X-User-Token header (per-request GCP access token) — override
 *   2. GOOGLE_REFRESH_TOKEN env (default path) — owner's Drive
 *   3. Application Default Credentials (service account) — legacy fallback
 *
 * NOTE: While the OAuth consent screen is in "Testing" mode, Google expires
 * the refresh token after ~7 days. Publish the consent screen to Production
 * for a long-lived token, or re-run the consent flow to mint a new one.
 *
 * Endpoints:
 *   GET  /health
 *   POST /create-doc            { title, html, folderId? }
 *   POST /mcp                   MCP protocol (initialize, tools/list, tools/call)
 *   GET/HEAD /mcp               401 + WWW-Authenticate (connector discovery)
 *   OAuth scaffold endpoints    (.well-known/*, /oauth/*) — NON-FUNCTIONAL
 *                               placeholder for the Claude connector flow;
 *                               does not implement real OAuth 2.1 + PKCE + DCR.
 *                               Connector integration remains a TODO.
 */

const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "10mb" }));

const CASES_FOLDER_ID = process.env.CASES_FOLDER_ID || "1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ";
const BASE_URL = "https://fafo-docs-mcp-134533637471.us-central1.run.app";

// Brand colors from CP_License_Agreement_2026.pages pixel analysis
const COLORS = {
  navy:    { red: 0.149, green: 0.212, blue: 0.424 }, // #26366C — H1/H2
  slate:   { red: 0.169, green: 0.208, blue: 0.251 }, // #2B3540 — H3
  body:    { red: 0.102, green: 0.102, blue: 0.102 }, // #1A1A1A — body text
  orange:  { red: 0.847, green: 0.388, blue: 0.239 }, // #D8633D — WHEREAS/keywords
  divider: { red: 0.784, green: 0.784, blue: 0.784 }, // #C8C8C8 — rule lines
};

const FONT_HEADING = "Georgia";  // FreightText Pro Book fallback
const FONT_BODY    = "Calibri";  // Avenir Next Regular fallback

async function getClients(userToken) {
  // 1. Per-request override: caller-supplied GCP access token
  if (userToken) {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: userToken });
    authClient.quotaProjectId = process.env.QUOTA_PROJECT || "project-b0292460-be69-4b2e-b3c";
    return {
      drive: google.drive({ version: "v3", auth: authClient }),
      docs:  google.docs({ version: "v1", auth: authClient }),
    };
  }
  // 2. Default path: stored refresh token authenticates as the owner
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return {
      drive: google.drive({ version: "v3", auth: oauth2 }),
      docs:  google.docs({ version: "v1", auth: oauth2 }),
    };
  }
  // 3. Legacy fallback: Application Default Credentials (service account)
  const auth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
    ],
  });
  const authClient = await auth.getClient();
  return {
    drive: google.drive({ version: "v3", auth: authClient }),
    docs:  google.docs({ version: "v1", auth: authClient }),
  };
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (req, res) =>
  res.json({ ok: true, service: "fafo-docs-mcp", version: "1.0.4" })
);

// ── HTML PARSING ──────────────────────────────────────────────────────────────
function parseInlines(html) {
  const parts = [];
  const re = /<(b|strong|i|em)[^>]*>([\s\S]*?)<\/\1>|([^<]+)|<[^>]+>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = (m[1] || "").toLowerCase();
    if (tag === "b" || tag === "strong") {
      parseInlines(m[2]).forEach(p => { p.bold = true; parts.push(p); });
    } else if (tag === "i" || tag === "em") {
      parseInlines(m[2]).forEach(p => { p.italic = true; parts.push(p); });
    } else if (m[3]) {
      const text = m[3]
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      if (text) parts.push({ text, bold: false, italic: false });
    }
  }
  return parts.length ? parts : [{ text: html.replace(/<[^>]+>/g, ""), bold: false, italic: false }];
}

function parseHtml(html) {
  const body = html
    .replace(/<html[^>]*>/gi, "").replace(/<\/html>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<body[^>]*>/gi, "").replace(/<\/body>/gi, "");
  const tokens = [];
  const blockRe = /<(h[1-3]|p|li|hr)[^>]*>([\s\S]*?)<\/\1>|<hr\s*\/?>/gi;
  let m;
  while ((m = blockRe.exec(body)) !== null) {
    const tag = (m[1] || "hr").toLowerCase();
    if (tag === "hr") { tokens.push({ tag: "hr" }); continue; }
    const inlines = parseInlines(m[2] || "");
    const plainText = inlines.map(i => i.text).join("");
    if (!plainText.trim()) { tokens.push({ tag: "blank" }); continue; }
    tokens.push({ tag: tag === "li" ? "bullet" : tag, inlines, text: plainText });
  }
  return tokens;
}

function buildRequests(tokens) {
  const requests = [];
  let idx = 1;
  const styleQueue = [];
  for (const token of tokens) {
    if (token.tag === "hr") {
      requests.push({ insertText: { location: { index: idx }, text: "\n" } });
      styleQueue.push({ type: "border", startIndex: idx, endIndex: idx + 1 });
      idx += 1; continue;
    }
    if (token.tag === "blank") {
      requests.push({ insertText: { location: { index: idx }, text: "\n" } });
      idx += 1; continue;
    }
    const blockText = token.text + "\n";
    requests.push({ insertText: { location: { index: idx }, text: blockText } });
    styleQueue.push({ type: "block", tag: token.tag, inlines: token.inlines,
      startIndex: idx, endIndex: idx + blockText.length - 1, blockEndIndex: idx + blockText.length });
    idx += blockText.length;
  }
  for (const s of styleQueue) {
    if (s.type === "border") {
      requests.push({ updateParagraphStyle: {
        range: { startIndex: s.startIndex, endIndex: s.endIndex },
        paragraphStyle: { borderBottom: { color: { color: { rgbColor: COLORS.divider } }, dashStyle: "SOLID",
          padding: { magnitude: 4, unit: "PT" }, width: { magnitude: 0.5, unit: "PT" } },
          spaceAbove: { magnitude: 8, unit: "PT" }, spaceBelow: { magnitude: 8, unit: "PT" } },
        fields: "borderBottom,spaceAbove,spaceBelow" } }); continue;
    }
    const { tag, inlines, startIndex, endIndex, blockEndIndex } = s;
    if (tag === "h1") {
      requests.push({ updateParagraphStyle: { range: { startIndex, endIndex: blockEndIndex },
        paragraphStyle: { namedStyleType: "HEADING_1", spaceAbove: { magnitude: 20, unit: "PT" }, spaceBelow: { magnitude: 6, unit: "PT" } },
        fields: "namedStyleType,spaceAbove,spaceBelow" } });
      requests.push({ updateTextStyle: { range: { startIndex, endIndex },
        textStyle: { foregroundColor: { color: { rgbColor: COLORS.navy } }, fontSize: { magnitude: 22, unit: "PT" },
          bold: false, weightedFontFamily: { fontFamily: FONT_HEADING } },
        fields: "foregroundColor,fontSize,bold,weightedFontFamily" } });
    } else if (tag === "h2") {
      requests.push({ updateParagraphStyle: { range: { startIndex, endIndex: blockEndIndex },
        paragraphStyle: { namedStyleType: "HEADING_2", spaceAbove: { magnitude: 16, unit: "PT" }, spaceBelow: { magnitude: 4, unit: "PT" } },
        fields: "namedStyleType,spaceAbove,spaceBelow" } });
      requests.push({ updateTextStyle: { range: { startIndex, endIndex },
        textStyle: { foregroundColor: { color: { rgbColor: COLORS.navy } }, fontSize: { magnitude: 16, unit: "PT" },
          bold: false, weightedFontFamily: { fontFamily: FONT_HEADING } },
        fields: "foregroundColor,fontSize,bold,weightedFontFamily" } });
    } else if (tag === "h3") {
      requests.push({ updateParagraphStyle: { range: { startIndex, endIndex: blockEndIndex },
        paragraphStyle: { namedStyleType: "HEADING_3", spaceAbove: { magnitude: 10, unit: "PT" }, spaceBelow: { magnitude: 2, unit: "PT" } },
        fields: "namedStyleType,spaceAbove,spaceBelow" } });
      requests.push({ updateTextStyle: { range: { startIndex, endIndex },
        textStyle: { foregroundColor: { color: { rgbColor: COLORS.slate } }, fontSize: { magnitude: 12, unit: "PT" },
          bold: true, weightedFontFamily: { fontFamily: FONT_BODY } },
        fields: "foregroundColor,fontSize,bold,weightedFontFamily" } });
    } else {
      if (tag === "bullet") {
        requests.push({ createParagraphBullets: { range: { startIndex, endIndex: blockEndIndex }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
      }
      requests.push({ updateTextStyle: { range: { startIndex, endIndex },
        textStyle: { foregroundColor: { color: { rgbColor: COLORS.body } }, fontSize: { magnitude: 10.5, unit: "PT" },
          bold: false, italic: false, weightedFontFamily: { fontFamily: FONT_BODY } },
        fields: "foregroundColor,fontSize,bold,italic,weightedFontFamily" } });
      if (inlines) {
        let ii = startIndex;
        for (const inline of inlines) {
          const end = ii + inline.text.length;
          if (end > endIndex) break;
          if (inline.bold || inline.italic) {
            requests.push({ updateTextStyle: { range: { startIndex: ii, endIndex: end },
              textStyle: { bold: !!inline.bold, italic: !!inline.italic }, fields: "bold,italic" } });
          }
          ii = end;
        }
      }
    }
  }
  return requests;
}

async function createDoc(title, html, folderId, userToken) {
  const targetFolder = folderId || CASES_FOLDER_ID;
  const { drive, docs } = await getClients(userToken);
  const createRes = await drive.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.document", parents: [targetFolder] },
    fields: "id,webViewLink",
  });
  const fileId = createRes.data.id;
  const tokens = parseHtml(html);
  const requests = buildRequests(tokens);
  const CHUNK = 200;
  for (let i = 0; i < requests.length; i += CHUNK) {
    await docs.documents.batchUpdate({ documentId: fileId, requestBody: { requests: requests.slice(i, i + CHUNK) } });
  }
  return { ok: true, fileId, editUrl: createRes.data.webViewLink,
    pdfUrl: "https://docs.google.com/document/d/" + fileId + "/export?format=pdf",
    docxUrl: "https://docs.google.com/document/d/" + fileId + "/export?format=docx" };
}

// ── POST /create-doc ─────────────────────────────────────────────────────────
app.post("/create-doc", async (req, res) => {
  try {
    const { title, html, folderId } = req.body;
    const userToken = req.headers["x-user-token"] || null;
    if (!title || !html) return res.status(400).json({ error: "title and html required" });
    res.json(await createDoc(title, html, folderId, userToken));
  } catch (err) {
    console.error("/create-doc error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── OAuth scaffold (NON-FUNCTIONAL placeholder for Claude connector) ───────────
// This does NOT implement real OAuth 2.1 + PKCE + Dynamic Client Registration.
// Claude's connector system rejects it. Kept for reference; connector = TODO.
const OAUTH_CLIENT_ID = "fafo-docs-client";
const OAUTH_CLIENT_SECRET = "fafo-docs-secret-2026";

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: BASE_URL + "/oauth/authorize",
    token_endpoint: BASE_URL + "/oauth/token",
    registration_endpoint: BASE_URL + "/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
  });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ["header"],
    resource_documentation: BASE_URL + "/health",
  });
});

app.post("/oauth/register", (req, res) => {
  const { client_name, redirect_uris } = req.body || {};
  res.status(201).json({
    client_id: OAUTH_CLIENT_ID, client_secret: OAUTH_CLIENT_SECRET,
    client_name: client_name || "FAFO Docs MCP", redirect_uris: redirect_uris || [],
    grant_types: ["authorization_code"], response_types: ["code"],
  });
});

app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  const code = "fafo-auth-code-" + Date.now();
  const sep = redirect_uri && redirect_uri.includes("?") ? "&" : "?";
  const dest = redirect_uri + sep + "code=" + code + (state ? "&state=" + encodeURIComponent(state) : "");
  const html = [
    "<!DOCTYPE html><html><head><meta charset=utf-8>",
    "<title>FAFO Docs MCP</title>",
    "<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:20px;text-align:center}",
    "h2{color:#26366C}.btn{display:inline-block;background:#26366C;color:#fff;padding:12px 32px;",
    "border-radius:8px;text-decoration:none;font-size:15px;font-weight:500}</style>",
    "</head><body>",
    "<h2>FAFO Docs MCP</h2>",
    "<p>Paleo Certified, Inc. dba The Paleo Foundation</p>",
    "<p>Click below to authorize Claude to create formatted Google Docs.</p>",
    '<a class=btn href="' + dest + '">Authorize Access</a>',
    "</body></html>"
  ].join("");
  res.send(html);
});

app.post("/oauth/token", express.urlencoded({ extended: true }), (req, res) => {
  res.json({ access_token: "fafo-static-token", token_type: "Bearer", expires_in: 86400, scope: "mcp" });
});

// ── MCP endpoint ─────────────────────────────────────────────────────────────
app.get("/mcp", (req, res) => {
  res.set("MCP-Protocol-Version", "2025-06-18");
  res.set("WWW-Authenticate", 'Bearer resource_metadata="' + BASE_URL + '/.well-known/oauth-protected-resource"');
  res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
});

app.head("/mcp", (req, res) => {
  res.set("MCP-Protocol-Version", "2025-06-18");
  res.set("WWW-Authenticate", 'Bearer resource_metadata="' + BASE_URL + '/.well-known/oauth-protected-resource"');
  res.status(401).end();
});

app.post("/mcp", async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    res.set("WWW-Authenticate", 'Bearer resource_metadata="' + BASE_URL + '/.well-known/oauth-protected-resource"');
    return res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
  }
  try {
    const { method, params } = req.body;
    if (method === "initialize") {
      return res.json({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fafo-docs-mcp", version: "1.0.4" } });
    }
    if (method === "tools/list") {
      return res.json({ tools: [{ name: "create_doc",
        description: "Create a formatted Google Doc in Drive from HTML. Returns edit URL and PDF/Word export links with Paleo Foundation brand styling.",
        inputSchema: { type: "object", properties: { title: { type: "string" }, html: { type: "string" }, folderId: { type: "string" } }, required: ["title", "html"] } }] });
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params;
      if (name !== "create_doc") return res.json({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Unknown tool: " + name }) }] });
      const mcpToken = req.headers["x-user-token"] || null;
      return res.json({ content: [{ type: "text", text: JSON.stringify(await createDoc(args.title, args.html, args.folderId, mcpToken)) }] });
    }
    res.json({ error: "Unknown method: " + method });
  } catch (err) {
    console.error("/mcp error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("FAFO Docs MCP v1.0.4 listening on port " + PORT));
