import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Encrypted secret store (SignNow API key, later the Anthropic key).
 * JSON map serialized through Electron safeStorage — on macOS the encryption
 * key lives in the user's Keychain. Secrets NEVER go in the settings table,
 * the repo, or plaintext files, with one bootstrap exception: a
 * userData/import/secrets-bootstrap.json (0600) written out-of-band is
 * absorbed into the encrypted store on launch and deleted.
 */

function storePath(): string {
  return path.join(app.getPath('userData'), 'secrets.bin')
}

function bootstrapPath(): string {
  return path.join(app.getPath('userData'), 'import', 'secrets-bootstrap.json')
}

let cache: Record<string, string> | null = null

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function load(): Record<string, string> {
  if (cache) return cache
  cache = {}
  const file = storePath()
  if (fs.existsSync(file) && canEncrypt()) {
    try {
      cache = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as Record<string, string>
    } catch {
      // Keychain reset or corrupt store — start clean rather than crash.
      cache = {}
    }
  }
  return cache
}

function persist(): void {
  if (!canEncrypt()) return // in-memory only rather than plaintext at rest
  fs.writeFileSync(storePath(), safeStorage.encryptString(JSON.stringify(cache ?? {})), {
    mode: 0o600
  })
}

export function getSecret(key: string): string | null {
  return load()[key] ?? null
}

export function setSecret(key: string, value: string): void {
  const store = load()
  if (value) store[key] = value
  else delete store[key]
  persist()
}

export function hasSecret(key: string): boolean {
  return Boolean(load()[key])
}

/** Call once on app ready, after safeStorage is usable. */
export function migrateBootstrapSecrets(): void {
  const file = bootstrapPath()
  if (!fs.existsSync(file)) return
  try {
    const incoming = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    const store = load()
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof v === 'string' && v) store[k] = v
    }
    persist()
    if (canEncrypt()) fs.rmSync(file) // only delete once safely absorbed
  } catch {
    // Malformed bootstrap: leave it for inspection, don't crash the app.
  }
}

export const SECRET_SIGNNOW_API_KEY = 'signnow.apiKey'
export const SECRET_ANTHROPIC_API_KEY = 'anthropic.apiKey'
/** Shared secret the docs-mcp service requires on every Drive-touching call. */
export const SECRET_DOCS_MCP_KEY = 'docsMcp.sharedKey'
