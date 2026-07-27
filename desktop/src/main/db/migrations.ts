import type Database from 'better-sqlite3'

/**
 * Ordered migrations applied via PRAGMA user_version. Append-only —
 * never edit an entry that has shipped; add a new one.
 * Money is stored in integer cents. Dates/times are ISO-8601 TEXT (UTC).
 * Binary payloads (screenshots, PDFs) are NEVER stored here — references only.
 */
const MIGRATIONS: string[] = [
  // 001 — core schema
  `
  CREATE TABLE licensees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    aka_names TEXT,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    address TEXT,
    drive_folder_id TEXT,
    local_folder_path TEXT,
    repeat_infringer INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX idx_licensees_normalized ON licensees(normalized_name);

  CREATE TABLE marks (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    program TEXT NOT NULL,
    uspto_reg_no TEXT NOT NULL,
    reg_status TEXT NOT NULL,
    notes TEXT
  );

  CREATE TABLE licenses (
    id INTEGER PRIMARY KEY,
    licensee_id INTEGER NOT NULL REFERENCES licensees(id),
    signnow_group_id TEXT UNIQUE,
    vintage TEXT NOT NULL DEFAULT '2025' CHECK (vintage IN ('2020','2025')),
    term_start TEXT,
    term_end TEXT,
    revenue_band TEXT,
    revenue_category TEXT,
    annual_fee_cents INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','expiring','expired','terminated','renewed')),
    agreement_ref TEXT,
    extraction_confidence REAL,
    extracted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_licenses_licensee ON licenses(licensee_id);
  CREATE INDEX idx_licenses_term_end ON licenses(term_end);

  CREATE TABLE license_marks (
    license_id INTEGER NOT NULL REFERENCES licenses(id),
    mark_id INTEGER NOT NULL REFERENCES marks(id),
    PRIMARY KEY (license_id, mark_id)
  );

  CREATE TABLE watch_items (
    id INTEGER PRIMARY KEY,
    licensee_id INTEGER NOT NULL REFERENCES licensees(id),
    license_id INTEGER REFERENCES licenses(id),
    opened_at TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('expiring','expired','manual')),
    status TEXT NOT NULL DEFAULT 'watching'
      CHECK (status IN ('watching','renewed','escalated','closed')),
    next_check_at TEXT,
    notes TEXT
  );

  CREATE TABLE cases (
    id INTEGER PRIMARY KEY,
    licensee_id INTEGER REFERENCES licensees(id),
    watch_item_id INTEGER REFERENCES watch_items(id),
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Resolved')),
    source TEXT NOT NULL DEFAULT 'Website',
    url TEXT,
    opened_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT CHECK (resolved_by IN ('JP','Trestle') OR resolved_by IS NULL),
    settlement_position TEXT,
    drive_folder_id TEXT,
    local_folder_path TEXT,
    legacy_import INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_cases_status ON cases(status);
  CREATE INDEX idx_cases_licensee ON cases(licensee_id);

  CREATE TABLE case_events (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    ref_table TEXT,
    ref_id INTEGER
  );
  CREATE INDEX idx_case_events_case ON case_events(case_id, at);

  CREATE TABLE tracked_urls (
    id INTEGER PRIMARY KEY,
    licensee_id INTEGER REFERENCES licensees(id),
    case_id INTEGER REFERENCES cases(id),
    watch_item_id INTEGER REFERENCES watch_items(id),
    url TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'website',
    active INTEGER NOT NULL DEFAULT 1,
    last_captured_at TEXT
  );

  CREATE TABLE captures (
    id INTEGER PRIMARY KEY,
    tracked_url_id INTEGER NOT NULL REFERENCES tracked_urls(id),
    captured_at TEXT NOT NULL,
    screenshot_path TEXT,
    drive_file_id TEXT,
    sha256 TEXT,
    byte_size INTEGER,
    http_status INTEGER,
    page_title TEXT,
    classification TEXT CHECK (classification IN ('confirmed','possible','flag','clear','error') OR classification IS NULL),
    classified_by TEXT,
    reviewed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE evidence_files (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id),
    path TEXT,
    drive_file_id TEXT,
    byte_size INTEGER,
    mtime TEXT,
    kind TEXT,
    dated_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual'
  );
  CREATE INDEX idx_evidence_case ON evidence_files(case_id);

  CREATE TABLE letters (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id),
    kind TEXT NOT NULL,
    body_text TEXT NOT NULL,
    drafted_at TEXT NOT NULL,
    sent_at TEXT,
    message_id TEXT,
    doc_drive_id TEXT,
    response_due_at TEXT,
    response_received_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','sent','responded','expired'))
  );

  CREATE TABLE deadlines (
    id INTEGER PRIMARY KEY,
    ref_table TEXT,
    ref_id INTEGER,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    due_at TEXT NOT NULL,
    satisfied_at TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_deadlines_due ON deadlines(due_at);

  CREATE TABLE settlements (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id),
    formula TEXT CHECK (formula IN ('ld','legacy') OR formula IS NULL),
    opening_demand_cents INTEGER,
    compromise_cents INTEGER,
    agreed_cents INTEGER,
    terms_notes TEXT,
    agreement_ref TEXT
  );

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id),
    amount_cents INTEGER NOT NULL,
    due_date TEXT,
    received_date TEXT,
    received INTEGER NOT NULL DEFAULT 0,
    legacy INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT CHECK (resolved_by IN ('JP','Trestle') OR resolved_by IS NULL),
    year INTEGER,
    source_label TEXT
  );

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT,
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT
  );

  CREATE TABLE sync_state (
    source TEXT PRIMARY KEY,
    cursor TEXT,
    last_full_sync_at TEXT
  );
  `
]

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
