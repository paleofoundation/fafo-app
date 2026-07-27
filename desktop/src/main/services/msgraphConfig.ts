/**
 * Microsoft Entra app registration for the paleofoundation.org tenant,
 * provided by Jonathan 2026-07-27. These are public-client identifiers,
 * not secrets: the app uses the device-code flow, so there is no client
 * secret anywhere. Overridable via the settings table (keys below) if the
 * registration is ever recreated.
 */

export const MS_CLIENT_ID_DEFAULT = '14d25506-187f-4748-bf05-05c445374910'
export const MS_TENANT_ID_DEFAULT = '69988ce5-38b3-4194-af66-24d94cf57f0e'

export const SETTING_MS_CLIENT_ID = 'ms.clientId'
export const SETTING_MS_TENANT_ID = 'ms.tenantId'

/**
 * Delegated scopes. Keep minimal: Mail.Read covers M4 correspondence capture
 * and response-clock detection. MSAL adds openid/profile/offline_access
 * itself. Mail.Send is requested later (incremental consent) only if letter
 * sending moves into the app.
 */
export const MS_SCOPES = ['Mail.Read']
