import { useCallback, useEffect, useState } from 'react'
import type {
  MsAuthStatus,
  MsDeviceCode,
  SignnowStatus,
  SignnowSyncNowResult
} from '../../../shared/types'

type AuthUiState =
  | { phase: 'idle' }
  | { phase: 'code'; code: MsDeviceCode }
  | { phase: 'error'; message: string }

function SignnowCard(): React.JSX.Element {
  const [status, setStatus] = useState<SignnowStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncResult, setSyncResult] = useState<SignnowSyncNowResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.fafo.signnowStatus().then(setStatus)
  }, [])

  async function saveKey(): Promise<void> {
    if (!keyDraft.trim()) return
    setBusy(true)
    setError(null)
    try {
      setStatus(await window.fafo.signnowSetKey(keyDraft.trim()))
      setKeyDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function syncNow(): Promise<void> {
    setBusy(true)
    setError(null)
    setSyncResult(null)
    try {
      setSyncResult(await window.fafo.signnowSyncNow())
      setStatus(await window.fafo.signnowStatus())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <div className="card">
      <h2>SignNow — nightly license sync</h2>
      {status && (
        <p className="subtitle">
          {status.keyPresent ? (
            <>
              <span className="pill done">key stored</span> (encrypted, key in macOS Keychain).{' '}
              {status.lastSyncAt
                ? `Last sync ${status.lastSyncAt.slice(0, 16).replace('T', ' ')} — ${status.lastSyncCursor}.`
                : 'Not synced yet.'}
              {status.lastJobStatus && ` Nightly job: ${status.lastJobStatus}`}
            </>
          ) : (
            'No API key stored. The nightly sync skips until one is added.'
          )}
        </p>
      )}
      <div className="add-row">
        <input
          type="password"
          placeholder={status?.keyPresent ? 'Replace API key…' : 'Paste SignNow API key…'}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <button className="outline" disabled={busy || !keyDraft.trim()} onClick={() => void saveKey()}>
          Save key
        </button>
        <button className="outline" disabled={busy || !status?.keyPresent} onClick={() => void syncNow()}>
          {busy ? 'Working…' : 'Sync now'}
        </button>
      </div>
      {syncResult && (
        <p style={{ marginTop: 10 }}>
          <span className="pill done">synced</span> as <strong>{syncResult.identityEmail}</strong> —{' '}
          {syncResult.apiTotal} documents visible, {syncResult.licensesCreated} licenses created,{' '}
          {syncResult.licensesUpdated} updated, {syncResult.activeLicenses} active.
          {syncResult.apiTotal === 0 && (
            <span style={{ color: 'var(--warn)' }}>
              {' '}
              This account sees no agreements — the key likely belongs to the wrong SignNow user.
            </span>
          )}
        </p>
      )}
      {error && <p style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</p>}
    </div>
  )
}

export function Settings(): React.JSX.Element {
  const [status, setStatus] = useState<MsAuthStatus | null>(null)
  const [ui, setUi] = useState<AuthUiState>({ phase: 'idle' })

  const refresh = useCallback(async () => {
    setStatus(await window.fafo.msStatus())
  }, [])

  useEffect(() => {
    void refresh()
    const unsubscribe = window.fafo.onMsAuthEvent((e) => {
      if (e.type === 'signedIn') {
        setUi({ phase: 'idle' })
        void refresh()
      } else {
        setUi({ phase: 'error', message: e.message })
      }
    })
    return unsubscribe
  }, [refresh])

  async function connect(): Promise<void> {
    try {
      const code = await window.fafo.msSignIn()
      setUi({ phase: 'code', code })
    } catch (err) {
      setUi({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function disconnect(): Promise<void> {
    await window.fafo.msSignOut()
    setUi({ phase: 'idle' })
    await refresh()
  }

  return (
    <div>
      <h1>Settings</h1>
      <p className="subtitle">Integrations and app configuration.</p>

      <div className="card">
        <h2>Outlook — jonathand@paleofoundation.org</h2>
        {!status && <div className="empty">Loading…</div>}
        {status && status.connected && (
          <div>
            <p>
              <span className="pill done">connected</span>{' '}
              <strong style={{ marginLeft: 6 }}>{status.username}</strong>
            </p>
            <p className="subtitle" style={{ marginBottom: 10 }}>
              Mail.Read granted. M4 will use this to attach case correspondence and stop response
              clocks automatically. Sign-in persists via an encrypted token cache
              {status.cacheEncrypted ? ' (key in your macOS Keychain).' : ' — WARNING: encryption unavailable on this machine, sign-in lasts this session only.'}
            </p>
            <button className="subtle" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        )}
        {status && !status.connected && ui.phase !== 'code' && (
          <div>
            <p className="subtitle">
              Not connected. One-time sign-in with your work account — you approve it on
              Microsoft&rsquo;s own page; FAFO never sees your password.
            </p>
            <button className="outline" onClick={() => void connect()}>
              Connect Outlook
            </button>
            {ui.phase === 'error' && (
              <p style={{ color: 'var(--danger)', marginTop: 10 }}>Sign-in failed: {ui.message}</p>
            )}
          </div>
        )}
        {ui.phase === 'code' && (
          <div>
            <p>
              1&nbsp;&nbsp;Open{' '}
              <a href={ui.code.verificationUri} target="_blank" rel="noreferrer">
                {ui.code.verificationUri}
              </a>{' '}
              (opens in your browser)
            </p>
            <p>
              2&nbsp;&nbsp;Enter this code:{' '}
              <strong
                style={{
                  fontSize: 20,
                  letterSpacing: '0.15em',
                  fontVariantNumeric: 'tabular-nums',
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  borderRadius: 7,
                  padding: '3px 10px'
                }}
              >
                {ui.code.userCode}
              </strong>
            </p>
            <p>3&nbsp;&nbsp;Sign in as jonathand@paleofoundation.org and approve.</p>
            <p className="subtitle">
              Waiting for you to finish on Microsoft&rsquo;s page… (code valid ~
              {Math.round(ui.code.expiresInSeconds / 60)} min). This panel updates by itself.
            </p>
          </div>
        )}
      </div>

      {status && (
        <div className="card">
          <h2>Entra app registration (public identifiers)</h2>
          <div className="field-row">
            <span className="field-label">Application ID</span>
            <code>{status.clientId}</code>
          </div>
          <div className="field-row">
            <span className="field-label">Directory ID</span>
            <code>{status.tenantId}</code>
          </div>
        </div>
      )}

      <SignnowCard />

      <div className="card">
        <h2>Coming in later milestones</h2>
        <p className="subtitle" style={{ marginBottom: 0 }}>
          Anthropic API key (letters, extraction, vision — M4) · patrol schedule (M3). Each appears
          here when its milestone lands.
        </p>
      </div>
    </div>
  )
}
