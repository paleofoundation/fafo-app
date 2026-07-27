import { describe, expect, it } from 'vitest'
import { mapRawDocument } from '../signnowApi'

describe('mapRawDocument', () => {
  it('maps a fulfilled agreement document', () => {
    const g = mapRawDocument({
      id: '8563cc97',
      document_name: 'CALCHEF FOODS LLC License Agreement 2026',
      updated: '1784813558',
      template: false,
      entity_type: 'document',
      field_invites: [
        { status: 'fulfilled', email: 'catherinep@kevinsnaturalfoods.com' },
        { status: 'fulfilled', email: 'catherinep@kevinsnaturalfoods.com' }
      ]
    })!
    expect(g.signed).toBe(true)
    expect(g.invite_status).toBe('completed')
    expect(g.participant_emails).toEqual(['catherinep@kevinsnaturalfoods.com'])
    expect(g.last_updated).toBe(1784813558)
  })

  it('pending invite → pending, not signed', () => {
    const g = mapRawDocument({
      id: 'x',
      document_name: 'BEDROCK BAKING LLC License Agreement 2026',
      field_invites: [{ status: 'pending', email: 'chris@bedrockbakers.com' }]
    })!
    expect(g.invite_status).toBe('pending')
    expect(g.signed).toBe(false)
  })

  it('no invites → null status (uploaded file, asserts nothing)', () => {
    const g = mapRawDocument({ id: 'y', document_name: 'grasshopper_2014.pdf', field_invites: [] })!
    expect(g.invite_status).toBeNull()
    expect(g.signed).toBe(false)
  })

  it('templates and non-document entities are dropped', () => {
    expect(mapRawDocument({ id: 't', document_name: 'CP Template', template: true })).toBeNull()
    expect(
      mapRawDocument({ id: 'f', document_name: 'Folder', entity_type: 'folder' })
    ).toBeNull()
  })
})
