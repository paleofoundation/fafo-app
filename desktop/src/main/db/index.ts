import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { migrate } from './migrations'
import { seedIfEmpty } from './seed'

let db: Database.Database | null = null

export function openDb(): Database.Database {
  if (db) return db
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'fafo.sqlite')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seedIfEmpty(db)
  return db
}

export function dbPath(): string {
  return path.join(app.getPath('userData'), 'fafo.sqlite')
}

export function closeDb(): void {
  db?.close()
  db = null
}
