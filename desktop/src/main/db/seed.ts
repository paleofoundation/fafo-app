import type Database from 'better-sqlite3'
import { normalizeCompanyName } from '../../shared/domain/naming'
import { selloffEnd } from '../../shared/domain/deadlines'

/**
 * First-run seed: the 6 marks (master reference §3) and the four active
 * matters (§10) with their known dates, plus a handful of resolved precedent
 * cases with received payments so Metrics has real data to roll up.
 * Dates that could NOT be verified from the reference get a review deadline
 * instead of a guessed value — accuracy over completeness.
 */
export function seedIfEmpty(db: Database.Database): void {
  const count = db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }
  if (count.n > 0) return

  const seed = db.transaction(() => {
    const insertMark = db.prepare(
      `INSERT INTO marks (code, name, program, uspto_reg_no, reg_status, notes)
       VALUES (@code, @name, @program, @reg, @status, @notes)`
    )
    const marks = [
      { code: 'KETO', name: 'THIS PRODUCT IS KETO CERTIFIED KETOCERTIFIED.COM', program: 'KETO Certified', reg: '6171595', status: 'Registered', notes: null },
      { code: 'CP', name: 'CERTIFIED P PALEO', program: 'Certified Paleo', reg: '4767643', status: 'Registered', notes: 'Filed as SERVICE mark — certification-mark statutory framework does not apply (per Trestle Law, Feb 9 2026). Letters must not overstate.' },
      { code: 'PF', name: 'THIS PRODUCT IS CERTIFIED PALEO FRIENDLY', program: 'Certified Paleo Friendly', reg: '4583649', status: 'Registered', notes: 'Grandfathered old + updated logos both authorized for active licensees.' },
      { code: 'PF2', name: 'CERTIFIED PF PALEO FRIENDLY', program: 'Certified Paleo Friendly', reg: '6214420', status: 'Registered', notes: null },
      { code: 'GF', name: 'LAB-TESTED GRAIN FREE CERTIFIED', program: 'Grain Free Certified', reg: '6676253', status: 'Registered', notes: 'Grandfathered old + updated logos both authorized.' },
      { code: 'GF2', name: 'LAB-TESTED NOGRAIN.ORG GRAIN FREE GLUTEN FREE', program: 'Grain Free Certified', reg: '6337794', status: 'Registered', notes: null },
      { code: 'PB', name: 'PLANT-BASED CERTIFIED', program: 'Plant-Based Certified', reg: '98507477', status: 'Pending', notes: 'Serial number only — NOT yet registered. Letters must not claim registration.' }
    ]
    for (const m of marks) insertMark.run(m)
    const markId = (code: string): number =>
      (db.prepare('SELECT id FROM marks WHERE code = ?').get(code) as { id: number }).id

    const insertLicensee = db.prepare(
      `INSERT INTO licensees (name, normalized_name, contact_name, contact_email, contact_phone)
       VALUES (?, ?, ?, ?, ?)`
    )
    const insertLicense = db.prepare(
      `INSERT INTO licenses (licensee_id, vintage, term_end, status, agreement_ref, extraction_confidence)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insertLicenseMark = db.prepare(
      'INSERT INTO license_marks (license_id, mark_id) VALUES (?, ?)'
    )
    const insertCase = db.prepare(
      `INSERT INTO cases (licensee_id, title, type, status, source, url, opened_at, resolved_at, resolved_by, settlement_position)
       VALUES (@licenseeId, @title, @type, @status, @source, @url, @openedAt, @resolvedAt, @resolvedBy, @settlement)`
    )
    const insertEvent = db.prepare(
      `INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, ?, ?)`
    )
    const insertDeadline = db.prepare(
      `INSERT INTO deadlines (ref_table, ref_id, kind, title, due_at) VALUES (?, ?, ?, ?, ?)`
    )
    const insertPayment = db.prepare(
      `INSERT INTO payments (case_id, amount_cents, received_date, received, resolved_by, year, source_label)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    )

    function licensee(name: string, contact?: string, email?: string, phone?: string): number {
      return Number(
        insertLicensee.run(name, normalizeCompanyName(name), contact ?? null, email ?? null, phone ?? null)
          .lastInsertRowid
      )
    }

    // ————— Active matters (master reference §10) —————

    // The Healthy Crunch Company — license expired 2025-11-26, 2025-template agreement.
    const hcId = licensee('The Healthy Crunch Company', 'Julie Bednarski-Malik')
    const hcLicense = Number(
      insertLicense.run(hcId, '2025', '2025-11-26', 'expired', 'THE HEALTHY CRUNCH COMPANY License Agreement 2025.pdf (Drive)', 1).lastInsertRowid
    )
    insertLicenseMark.run(hcLicense, markId('CP'))
    insertLicenseMark.run(hcLicense, markId('PF'))
    const hcCase = Number(
      insertCase.run({
        licenseeId: hcId,
        title: 'The Healthy Crunch Company',
        type: 'Expired License',
        status: 'In Progress',
        source: 'Website',
        url: 'healthycrunch.com',
        openedAt: '2025-11-26',
        resolvedAt: null,
        resolvedBy: null,
        settlement: '$10,000 + full cessation'
      }).lastInsertRowid
    )
    insertEvent.run(hcCase, '2025-11-26', 'note', 'License expired November 26, 2025.')
    insertEvent.run(hcCase, '2026-01-01', 'note', 'Post-termination use confirmed on website, social media, and packaging. Unauthorized products: CP mark used on PF-only products — unauthorized product use is not covered by any sell-off extension.')
    insertEvent.run(hcCase, '2026-02-01', 'note', 'Costco advertising campaign ran after agreed removal deadline.')
    insertEvent.run(hcCase, '2026-03-01', 'note', 'Confidentiality agreement executed. Healthy Crunch producing cessation documents.')
    insertEvent.run(hcCase, '2026-04-09', 'note', 'Amanda Bruss handling directly. Opposing counsel: Mr. Sultan.')
    const hcSelloff = selloffEnd('2025-11-26', '2025')!
    insertDeadline.run('cases', hcCase, 'selloff_end', 'Healthy Crunch sell-off window ended — verify cessation documents received (spot check)', hcSelloff)

    // Love Good Foods — 2020 legacy agreement (The Good Fat Co.), no sell-off.
    const lgId = licensee('Love Good Foods (1000747000 Ontario Inc)', 'Darryl Hartman', 'darryl@lovegoodfats.com', '416-712-2580')
    const lgLicense = Number(
      insertLicense.run(lgId, '2020', '2023-07-30', 'expired', 'The Good Fat Co. Ltd. 2020 agreement — signed personally by Darryl Hartman', 1).lastInsertRowid
    )
    insertLicenseMark.run(lgLicense, markId('KETO'))
    const lgCase = Number(
      insertCase.run({
        licenseeId: lgId,
        title: 'Love Good Foods',
        type: 'Unlicensed Use - Change in Ownership',
        status: 'In Progress',
        source: 'Website',
        url: 'lovegoodfats.com',
        openedAt: '2024-01-30',
        resolvedAt: null,
        resolvedBy: null,
        settlement: '$30,000 cessation OR $40,000 new 2-year license (preferred)'
      }).lastInsertRowid
    )
    insertEvent.run(lgCase, '2024-01-30', 'note', 'Acquired assets of The Good Fat Co. Ltd. through bankruptcy without executing new agreement per Section P. Original license expired July 30, 2023.')
    insertEvent.run(lgCase, '2024-01-30', 'note', '2020 legacy agreement — no sell-off period, no liquidated damages clause. Darryl Hartman personally signed.')
    insertEvent.run(lgCase, '2026-03-31', 'note', 'Use confirmed via Instagram reel.')
    insertEvent.run(lgCase, '2026-04-09', 'note', 'AMANDA reply sent; awaiting response. Remediation underway: 2 of 4 SKUs repackaged; website relaunched April 9, 2026. CEO: Paul Schiffner.')
    insertDeadline.run('cases', lgCase, 'letter_response', 'Love Good Foods — response to AMANDA reply overdue; assess escalation to Trestle', '2026-04-23')

    // Rawcology Inc. — second infringement; active litigation posture.
    const rawId = licensee('Rawcology Inc.', 'Tara Tomulka')
    const rawCase = Number(
      insertCase.run({
        licenseeId: rawId,
        title: 'Rawcology Inc.',
        type: 'Expired License',
        status: 'In Progress',
        source: 'Website',
        url: 'rawcology.com',
        openedAt: '2025-07-01',
        resolvedAt: null,
        resolvedBy: null,
        settlement: '$30,000 opening / $25,000 compromise'
      }).lastInsertRowid
    )
    insertEvent.run(rawCase, '2025-07-01', 'note', 'Second infringement — prior settlement completed July 2025. History of late payments. Second infringement = willful.')
    insertEvent.run(rawCase, '2026-01-01', 'note', 'Post-termination use confirmed including unauthorized product: Mint Chip Granola — never audited for current term.')
    insertEvent.run(rawCase, '2026-02-01', 'note', 'Veiled public threats; ChatGPT-drafted legal arguments submitted.')
    insertEvent.run(rawCase, '2026-04-09', 'note', 'Represented by Santen & Barristers.')
    insertDeadline.run('cases', rawCase, 'review', 'Rawcology — confirm current license term dates from RAWCOLOGY INC. License Agreement 2025.pdf (extraction pending)', '2026-07-31')

    // Little West — never certified; litigation, default judgment pending.
    const lwId = licensee('Little West (WS West LLC)')
    const lwCase = Number(
      insertCase.run({
        licenseeId: lwId,
        title: 'Little West',
        type: 'Unlicensed Use - Never Certified',
        status: 'In Progress',
        source: 'Website',
        url: 'littlewest.com',
        openedAt: '2025-01-01',
        resolvedAt: null,
        resolvedBy: null,
        settlement: 'Litigation — default judgment pending'
      }).lastInsertRowid
    )
    insertEvent.run(lwCase, '2025-01-01', 'note', 'No license — unauthorized use of Certified Paleo mark.')
    insertEvent.run(lwCase, '2025-06-01', 'note', 'Case filed: 3:25-cv-02823-RBM-BJW, USDC Southern District of California.')
    insertEvent.run(lwCase, '2026-04-09', 'note', 'Motion for default judgment filed; response deadline passed. Ruling expected within ~6 weeks.')
    insertDeadline.run('cases', lwCase, 'custom', 'Little West — check S.D. Cal. docket for default judgment ruling (expected ~6 weeks from 2026-04-09)', '2026-05-21')

    // ————— Resolved precedent cases with received payments (Metrics data) —————
    const precedents: Array<{ name: string; type: string; settlement: string; payments: Array<[number, string]>; note: string }> = [
      { name: 'Allive Europe UAB', type: 'Unlicensed Use - Never Certified', settlement: '$4,000', payments: [[4000_00, '2023-06-01']], note: 'Settled at $4,000. KETO Certified mark.' },
      { name: 'Laitram / Prime Shrimp LLC', type: 'Unlicensed Use - Never Certified', settlement: '$6,000', payments: [[6000_00, '2023-08-01']], note: 'Settled at $6,000. KETO Certified mark.' },
      { name: 'Yoleez LLC', type: 'Expired License', settlement: '$3,000 + $5,250 sell-off extension', payments: [[3000_00, '2023-09-01'], [5250_00, '2023-10-01']], note: 'Settled $3,000 + $5,250 sell-off extension. KETO Certified.' }
    ]
    for (const p of precedents) {
      const lid = licensee(p.name)
      const cid = Number(
        insertCase.run({
          licenseeId: lid,
          title: p.name,
          type: p.type,
          status: 'Resolved',
          source: 'Website',
          url: null,
          openedAt: '2023-01-01',
          resolvedAt: p.payments[p.payments.length - 1]?.[1] ?? null,
          resolvedBy: null,
          settlement: p.settlement
        }).lastInsertRowid
      )
      insertEvent.run(cid, '2023-01-01', 'note', p.note)
      for (const [cents, date] of p.payments) {
        insertPayment.run(cid, cents, date, null, parseInt(date.slice(0, 4), 10), p.name)
      }
    }
  })
  seed()
}
