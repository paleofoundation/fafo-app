import { useCallback, useEffect, useState } from 'react'
import type { MsAuthStatus, MsDeviceCode } from '../../../shared/types'

type AuthUiState =
  | { phase: 'idle' }
  | { phase: 'code'; code: MsDeviceCode }
  | { phase: 'error'; message: string }

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

      <div className="card">
        <h2>Coming in later milestones</h2>
        <p className="subtitle" style={{ marginBottom: 0 }}>
          SignNow API credentials (M2 sync) · Anthropic API key (letters, extraction, vision) ·
          Google Drive/Sheets (M2) · patrol schedule (M3). Each appears here when its milestone
          lands.
        </p>
      </div>
    </div>
  )
}
