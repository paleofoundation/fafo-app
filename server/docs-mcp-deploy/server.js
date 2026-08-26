/**
 * FAFO Docs MCP Server v2
 * Paleo Certified, Inc. dba The Paleo Foundation
 *
 * Creates formatted Google Docs matching the CP License Agreement visual style:
 *   - Top bar:      #E2E4EF (lavender-blue, full width)
 *   - H1 (title):  FreightText/Georgia, 22pt, #26366C navy
 *   - H2:          FreightText/Georgia, 16pt, #26366C navy  
 *   - H3:          Avenir Next/Calibri, 12pt bold, #2B3540 slate
 *   - Body:        Avenir Next/Calibri, 10.5pt, #1A1A1A near-black
 *   - Keywords:    Bold, #D8633D burnt orange (WHEREAS, key terms)
 *   - Dividers:    Thin grey rule #C8C8C8 after each heading
 *   - Bottom bar:  #D3D4E6 footer band
 */

const crypto = require("crypto");
const express = require("express");
const { google } = require("googleapis");
const { Readable } = require("stream");

const app = express();
app.use(express.json({ limit: "25mb" }));

const CASES_FOLDER_ID = process.env.CASES_FOLDER_ID || "1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ";

// Brand colors from CP_License_Agreement_2026.pages pixel analysis
const COLORS = {
  navy:    { red: 0.149, green: 0.212, blue: 0.424 }, // #26366C — H1/H2
  slate:   { red: 0.169, green: 0.208, blue: 0.251 }, // #2B3540 — H3
  body:    { red: 0.102, green: 0.102, blue: 0.102 }, // #1A1A1A — body text
  orange:  { red: 0.847, green: 0.388, blue: 0.239 }, // #D8633D — WHEREAS/keywords
  divider: { red: 0.784, green: 0.784, blue: 0.784 }, // #C8C8C8 — rule lines
  topbar:  { red: 0.886, green: 0.894, blue: 0.937 }, // #E2E4EF — header band
};

// Fonts — primary (requires install on client) / fallback (universal)
const FONT_HEADING = "Georgia";   // FreightText Pro Book fallback
const FONT_BODY    = "Calibri";   // Avenir Next Regular fallback

async function getClients(userToken) {
  if (userToken) {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: userToken });
    const quotaProject = process.env.QUOTA_PROJECT || "project-b0292460-be69-4b2e-b3c";
    authClient.quotaProjectId = quotaProject;
    return {
      drive: google.drive({ version: "v3", auth: authClient }),
      docs:  google.docs({ version: "v1", auth: authClient }),
    };
  }
  // Default path: use stored refresh token to authenticate as the user
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-FAFO-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


// ── AUTH ──────────────────────────────────────────────────────────────────────
// Cloud Run's invoker check is the outer door; this is the inner one, so the
// service is not one `allUsers` binding away from being wide open again.
// Fails CLOSED: with no secret configured, Drive routes refuse rather than
// silently serving anonymous callers.
const SHARED_SECRET = process.env.FAFO_SHARED_SECRET || "";

function authorized(req) {
  if (!SHARED_SECRET) return false;
  const presented = req.headers["x-fafo-key"];
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(SHARED_SECRET);
  // Compare in constant time, but only when lengths match — timingSafeEqual
  // throws on a length mismatch, which would itself leak length.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireKey(req, res, next) {
  if (authorized(req)) return next();
  console.warn(`rejected unauthenticated ${req.method} ${req.path}`);
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

app.get("/health", (req, res) =>
  res.json({ ok: true, service: "fafo-docs-mcp", version: "2.1" })
);

function parseInlines(html) {
  const parts = [];
  const re = /<(b|strong|i|em)[^>]*>([\s\S]*?)<\/\1>|([^<]+)|<[^>]+>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = (m[1] || "").toLowerCase();
    if (tag === "b" || tag === "strong") {
      const inner = parseInlines(m[2]);
      inner.forEach(p => { p.bold = true; parts.push(p); });
    } else if (tag === "i" || tag === "em") {
      const inner = parseInlines(m[2]);
      inner.forEach(p => { p.italic = true; parts.push(p); });
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
  const blockRe = /<(h[1-3]|p|li|hr)[^>]*>([\s\S]*?)<\/\1>|<hr\s*\/?>|<img[^>]*>/gi;
  let m;
  while ((m = blockRe.exec(body)) !== null) {
    if (m[0].toLowerCase().startsWith("<img")) {
      const idAttr = m[0].match(/data-fafo-image="([^"]+)"/i);
      if (idAttr) tokens.push({ tag: "image", imageId: idAttr[1] });
      continue;
    }
    const tag = (m[1] || "hr").toLowerCase();
    if (tag === "hr") { tokens.push({ tag: "hr" }); continue; }
    const inlines = parseInlines(m[2] || "");
    const plainText = inlines.map(i => i.text).join("");
    if (!plainText.trim()) { tokens.push({ tag: "blank" }); continue; }
    tokens.push({ tag: tag === "li" ? "bullet" : tag, inlines, text: plainText });
  }
  return tokens;
}

function buildRequests(tokens, staged) {
  const images = staged || {};
  const requests = [];
  let idx = 1;
  const styleQueue = [];
  for (const token of tokens) {
    if (token.tag === "image") {
      const img = images[token.imageId];
      // A capture that could not be staged degrades to a text line rather than
      // taking the whole referral down with it.
      if (!img) {
        const note = "[Exhibit " + token.imageId + " — image unavailable]\n";
        requests.push({ insertText: { location: { index: idx }, text: note } });
        idx += note.length; continue;
      }
      const objectSize = {};
      if (img.widthPt)  objectSize.width  = { magnitude: img.widthPt,  unit: "PT" };
      if (img.heightPt) objectSize.height = { magnitude: img.heightPt, unit: "PT" };
      requests.push({ insertInlineImage: { location: { index: idx }, uri: img.uri,
        ...(objectSize.width ? { objectSize } : {}) } });
      styleQueue.push({ type: "imageAlign", startIndex: idx, endIndex: idx + 2 });
      idx += 1;
      requests.push({ insertText: { location: { index: idx }, text: "\n" } });
      idx += 1;
      continue;
    }
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
    if (s.type === "imageAlign") {
      requests.push({ updateParagraphStyle: { range: { startIndex: s.startIndex, endIndex: s.endIndex },
        paragraphStyle: { alignment: "CENTER", spaceAbove: { magnitude: 10, unit: "PT" },
          spaceBelow: { magnitude: 2, unit: "PT" } },
        fields: "alignment,spaceAbove,spaceBelow" } }); continue;
    }
    if (s.type === "border") {
      requests.push({ updateParagraphStyle: { range: { startIndex: s.startIndex, endIndex: s.endIndex },
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


/**
 * Google's Docs backend fetches an image by URL at insert time and copies the
 * bytes into the document, so the source only has to be reachable for the
 * duration of the batchUpdate. Each capture is therefore uploaded to Drive,
 * shared by link, inserted, and then unshared and removed — the originals live
 * in the case folder on the user's machine, and these are staging copies with a
 * lifetime of a few seconds.
 *
 * Google has changed the public-file endpoint more than once; this form is the
 * one verified against the Docs fetcher (see server/README.md). If it ever
 * stops resolving, the symptom is a 400 "Invalid image URL" from batchUpdate.
 */
const IMAGE_URL = (fileId) => "https://lh3.googleusercontent.com/d/" + fileId;

async function stageImages(drive, images, folderId) {
  const staged = {};
  const fileIds = [];
  for (const img of images) {
    if (!img || !img.id || !img.dataBase64) continue;
    const bytes = Buffer.from(img.dataBase64, "base64");
    const res = await drive.files.create({
      requestBody: { name: "fafo-exhibit-" + img.id + ".jpg", parents: [folderId] },
      media: { mimeType: img.mimeType || "image/jpeg", body: Readable.from(bytes) },
      fields: "id",
    });
    const fileId = res.data.id;
    fileIds.push(fileId);
    await drive.permissions.create({
      fileId, requestBody: { role: "reader", type: "anyone" },
    });
    staged[img.id] = { uri: IMAGE_URL(fileId), widthPt: img.widthPt, heightPt: img.heightPt };
  }
  return { staged, fileIds };
}

async function unstageImages(drive, fileIds) {
  for (const fileId of fileIds) {
    // Scoped to files this same request created moments ago — never a caller
    // supplied id, which is why no delete endpoint is exposed.
    try { await drive.files.delete({ fileId }); }
    catch (e) { console.warn("staging cleanup failed for " + fileId + ":", e.message); }
  }
}

async function createDoc(title, html, folderId, userToken, images) {
  const targetFolder = folderId || CASES_FOLDER_ID;
  const { drive, docs } = await getClients(userToken);
  const createRes = await drive.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.document", parents: [targetFolder] },
    fields: "id,webViewLink",
  });
  const fileId = createRes.data.id;
  // Transfer ownership to user so file counts against their quota, not the service account
  const ownerEmail = process.env.OWNER_EMAIL || "jinthemad@gmail.com";
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: "owner", type: "user", emailAddress: ownerEmail },
      transferOwnership: true,
      sendNotificationEmail: false,
    });
  } catch(e) { console.warn("Ownership transfer failed:", e.message); }
  const tokens = parseHtml(html);
  let staged = {}, stagedIds = [];
  if (Array.isArray(images) && images.length) {
    try {
      const r = await stageImages(drive, images, targetFolder);
      staged = r.staged; stagedIds = r.fileIds;
    } catch (e) {
      console.warn("image staging failed, rendering text placeholders:", e.message);
    }
  }
  try {
    const requests = buildRequests(tokens, staged);
    const CHUNK = 200;
    for (let i = 0; i < requests.length; i += CHUNK) {
      await docs.documents.batchUpdate({ documentId: fileId, requestBody: { requests: requests.slice(i, i + CHUNK) } });
    }
  } finally {
    await unstageImages(drive, stagedIds);
  }
  return { ok: true, fileId, editUrl: createRes.data.webViewLink,
    pdfUrl: "https://docs.google.com/document/d/" + fileId + "/export?format=pdf",
    docxUrl: "https://docs.google.com/document/d/" + fileId + "/export?format=docx" };
}

app.post("/create-doc", requireKey, async (req, res) => {
  try {
    const { title, html, folderId, images } = req.body;
    const userToken = req.headers["x-user-token"] || null;
    if (!title || !html) return res.status(400).json({ error: "title and html required" });
    res.json(await createDoc(title, html, folderId, userToken, images));
  } catch (err) {
    console.error("/create-doc error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/mcp", requireKey, async (req, res) => {
  // Require Bearer token
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    const base = 'https://fafo-docs-mcp-134533637471.us-central1.run.app';
    res.set('WWW-Authenticate', 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource"');
    return res.status(401).json({ error: 'unauthorized', error_description: 'Bearer token required' });
  }
  try {
    const { method, params } = req.body;
    if (method === "initialize") {
      return res.json({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fafo-docs-mcp", version: "2.0.0" } });
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


// REMOVED 2026-08-11: /empty-trash, /list-files and /delete-all-files.
// They were reachable unauthenticated from the public internet and were not
// scoped to the FAFO folder — /delete-all-files ran a bare drive.files.list()
// across the whole account, deleted every result, then emptied the trash. A
// document-generation service has no reason to hold Drive-wide delete, so they
// are deleted rather than gated: an endpoint that does not exist cannot be
// misconfigured back open.

// OAuth endpoints required by Claude connector registration
const OAUTH_CLIENT_ID = 'fafo-docs-client';
const OAUTH_CLIENT_SECRET = 'fafo-docs-secret-2026';
const OAUTH_REDIRECT_WHITELIST = [];

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = 'https://fafo-docs-mcp-134533637471.us-central1.run.app';
  res.json({
    issuer: base,
    authorization_endpoint: base + '/oauth/authorize',
    token_endpoint: base + '/oauth/token',
    registration_endpoint: base + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
  });
});

app.post('/oauth/register', (req, res) => {
  const { client_name, redirect_uris } = req.body || {};
  res.status(201).json({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    client_name: client_name || 'FAFO Docs MCP',
    redirect_uris: redirect_uris || [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
});

app.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state } = req.query;
  const code = 'fafo-auth-code-' + Date.now();
  const sep = redirect_uri && redirect_uri.includes('?') ? '&' : '?';
  const dest = redirect_uri + sep + 'code=' + code + (state ? '&state=' + encodeURIComponent(state) : '');
  const html = [
    '<!DOCTYPE html><html><head><meta charset=utf-8>',
    '<title>FAFO Docs MCP</title>',
    '<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:20px;text-align:center}',
    'h2{color:#26366C}.btn{display:inline-block;background:#26366C;color:#fff;padding:12px 32px;',
    'border-radius:8px;text-decoration:none;font-size:15px;font-weight:500}</style>',
    '</head><body>',
    '<h2>FAFO Docs MCP</h2>',
    '<p>Paleo Certified, Inc. dba The Paleo Foundation</p>',
    '<p>Click below to authorize Claude to create formatted Google Docs.</p>',
    '<a class=btn href="' + dest + '">Authorize Access</a>',
    '</body></html>'
  ].join('');
  res.send(html);
});

app.post('/oauth/token', express.urlencoded({ extended: true }), (req, res) => {
  // Accept any client credentials from our registration
  res.json({
    access_token: 'fafo-static-token',
    token_type: 'Bearer',
    expires_in: 86400,
    scope: 'mcp',
  });
});


// Protected Resource Metadata (RFC 9728) — required by Claude connector auth flow
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = 'https://fafo-docs-mcp-134533637471.us-central1.run.app';
  res.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_documentation: base + '/health',
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("FAFO Docs MCP v2 listening on port " + PORT));

// Exported for offline verification of the index arithmetic (see
// server/docs-mcp-deploy/check-requests.js). Not used by the service itself.
module.exports = { parseHtml, buildRequests };
