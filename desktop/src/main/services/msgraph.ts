import {
  PublicClientApplication,
  type AccountInfo,
  type ICachePlugin,
  type TokenCacheContext
} from '@azure/msal-node'
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  MS_CLIENT_ID_DEFAULT,
  MS_SCOPES,
  MS_TENANT_ID_DEFAULT,
  SETTING_MS_CLIENT_ID,
  SETTING_MS_TENANT_ID
} from './msgraphConfig'
import { getSetting } from '../db/queries'

export interface MsAuthStatus {
  connected: boolean
  username: string | null
  clientId: string
  tenantId: string
  cacheEncrypted: boolean
}

export interface MsDeviceCode {
  userCode: string
  verificationUri: string
  message: string
  expiresInSeconds: number
}

export type MsAuthEvent =
  | { type: 'signedIn'; username: string }
  | { type: 'error'; message: string }

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'ms-token-cache.bin')
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * MSAL cache persisted to disk. Encrypted with Electron safeStorage (macOS:
 * key held in the user's Keychain). If encryption is unavailable we refuse to
 * persist rather than write refresh tokens in plaintext — sign-in then lasts
 * for the app session only.
 */
const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
    const file = cacheFile()
    if (!fs.existsSync(file) || !canEncrypt()) return
    try {
      const encrypted = fs.readFileSync(file)
      ctx.tokenCache.deserialize(safeStorage.decryptString(encrypted))
    } catch {
      // Corrupt/undecryptable cache (e.g. Keychain reset) — start clean.
      fs.rmSync(file, { force: true })
    }
  },
  async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
    if (!ctx.cacheHasChanged || !canEncrypt()) return
    const encrypted = safeStorage.encryptString(ctx.tokenCache.serialize())
    fs.writeFileSync(cacheFile(), encrypted, { mode: 0o600 })
  }
}

let pca: PublicClientApplication | null = null
let signInInFlight = false

function ids(db: Database.Database): { clientId: string; tenantId: string } {
  return {
    clientId: getSetting(db, SETTING_MS_CLIENT_ID) ?? MS_CLIENT_ID_DEFAULT,
    tenantId: getSetting(db, SETTING_MS_TENANT_ID) ?? MS_TENANT_ID_DEFAULT
  }
}

function client(db: Database.Database): PublicClientApplication {
  if (pca) return pca
  const { clientId, tenantId } = ids(db)
  pca = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`
    },
    cache: { cachePlugin }
  })
  return pca
}

async function firstAccount(db: Database.Database): Promise<AccountInfo | null> {
  const accounts = await client(db).getTokenCache().getAllAccounts()
  return accounts[0] ?? null
}

export async function msStatus(db: Database.Database): Promise<MsAuthStatus> {
  const account = await firstAccount(db)
  const { clientId, tenantId } = ids(db)
  return {
    connected: account !== null,
    username: account?.username ?? null,
    clientId,
    tenantId,
    cacheEncrypted: canEncrypt()
  }
}

/**
 * Device-code sign-in. Resolves with the code the moment Microsoft issues it
 * (the UI shows it immediately); completion/failure is reported via onEvent
 * when Jonathan finishes at microsoft.com/devicelogin.
 */
export async function msSignIn(
  db: Database.Database,
  onEvent: (e: MsAuthEvent) => void
): Promise<MsDeviceCode> {
  if (signInInFlight) throw new Error('A Microsoft sign-in is already in progress')
  signInInFlight = true

  return new Promise<MsDeviceCode>((resolveCode, rejectCode) => {
    let codeDelivered = false
    client(db)
      .acquireTokenByDeviceCode({
        scopes: MS_SCOPES,
        deviceCodeCallback: (info) => {
          codeDelivered = true
          resolveCode({
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            message: info.message,
            expiresInSeconds: info.expiresIn
          })
        }
      })
      .then((result) => {
        signInInFlight = false
        onEvent({ type: 'signedIn', username: result?.account?.username ?? 'unknown account' })
      })
      .catch((err: unknown) => {
        signInInFlight = false
        const message = err instanceof Error ? err.message : String(err)
        if (codeDelivered) {
          onEvent({ type: 'error', message })
        } else {
          rejectCode(new Error(message))
        }
      })
  })
}

export async function msSignOut(db: Database.Database): Promise<void> {
  const cache = client(db).getTokenCache()
  for (const account of await cache.getAllAccounts()) {
    await cache.removeAccount(account)
  }
  fs.rmSync(cacheFile(), { force: true })
}

/** Silent token for Graph calls (M4: mail scan, response clocks). */
export async function msAccessToken(db: Database.Database): Promise<string> {
  const account = await firstAccount(db)
  if (!account) throw new Error('Not signed in to Microsoft — connect Outlook in Settings first')
  const result = await client(db).acquireTokenSilent({ account, scopes: MS_SCOPES })
  if (!result?.accessToken) throw new Error('Could not acquire a Microsoft Graph token silently')
  return result.accessToken
}
