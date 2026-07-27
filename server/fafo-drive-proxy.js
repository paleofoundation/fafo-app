/**
 * FAFO Drive Proxy — Google Cloud Run
 * Paleo Certified, Inc. dba The Paleo Foundation
 *
 * Endpoints:
 *   POST /folder   { infringerName }              → { folderId, folderUrl }
 *   POST /upload   { infringerName, fileName, mimeType, base64 } → { fileId, fileUrl }
 *   GET  /health                                  → { ok: true }
 *
 * Environment variables required:
 *   GOOGLE_APPLICATION_CREDENTIALS  (set automatically on Cloud Run with a service account)
 *   CASES_FOLDER_ID                 (the "Cases" folder inside 1 - FAFO App)
 *   ALLOWED_ORIGIN                  (your artifact origin, or * for development)
 */

const express = require("express");
const { google } = require("googleapis");
const { Readable } = require("stream");

const app = express();
app.use(express.json({ limit: "50mb" }));

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function getDrive() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const authClient = await auth.getClient();
  return google.drive({ version: "v3", auth: authClient });
}

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Find a folder by name inside a parent, or create it if it doesn't exist.
 * Returns the folder ID.
 */
async function getOrCreateFolder(drive, name, parentId) {
  // Escape single quotes in the folder name for the query
  const safeName = name.replace(/'/g, "\\'");

  const searchRes = await drive.files.list({
    q: `title = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (searchRes.data.files && searchRes.data.files.length > 0) {
    return searchRes.data.files[0].id;
  }

  // Not found — create it
  const createRes = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });

  return createRes.data.id;
}

// ── POST /folder ──────────────────────────────────────────────────────────────
// Body: { infringerName: string }
// Returns: { folderId, folderUrl }
app.post("/folder", async (req, res) => {
  try {
    const { infringerName } = req.body;
    if (!infringerName) return res.status(400).json({ error: "infringerName required" });

    const casesFolderId = process.env.CASES_FOLDER_ID;
    if (!casesFolderId) return res.status(500).json({ error: "CASES_FOLDER_ID not configured" });

    const drive = await getDrive();
    const folderId = await getOrCreateFolder(drive, infringerName, casesFolderId);
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;

    res.json({ folderId, folderUrl });
  } catch (err) {
    console.error("/folder error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /upload ──────────────────────────────────────────────────────────────
// Body: { infringerName, fileName, mimeType, base64 }
// Returns: { fileId, fileUrl, folderId }
app.post("/upload", async (req, res) => {
  try {
    const { infringerName, fileName, mimeType, base64 } = req.body;
    if (!infringerName || !fileName || !base64) {
      return res.status(400).json({ error: "infringerName, fileName, and base64 are required" });
    }

    const casesFolderId = process.env.CASES_FOLDER_ID;
    if (!casesFolderId) return res.status(500).json({ error: "CASES_FOLDER_ID not configured" });

    const drive = await getDrive();

    // Ensure case folder exists
    const folderId = await getOrCreateFolder(drive, infringerName, casesFolderId);

    // Strip data URL prefix if present (e.g. "data:application/pdf;base64,...")
    const rawBase64 = base64.includes(",") ? base64.split(",")[1] : base64;
    const buffer = Buffer.from(rawBase64, "base64");

    // Upload file
    const uploadRes = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: mimeType || "application/octet-stream",
        parents: [folderId],
      },
      media: {
        mimeType: mimeType || "application/octet-stream",
        body: Readable.from(buffer),
      },
      fields: "id, webViewLink",
    });

    const fileId = uploadRes.data.id;
    const fileUrl = uploadRes.data.webViewLink;

    res.json({ fileId, fileUrl, folderId });
  } catch (err) {
    console.error("/upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`FAFO Drive Proxy listening on port ${PORT}`));
