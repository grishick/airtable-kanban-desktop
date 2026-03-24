import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import { randomUUID } from 'crypto';

export interface Task {
  id: string;
  airtable_id: string | null;
  title: string;
  description: string;
  status: string;
  priority: string | null;
  due_date: string | null;
  assigned_to: string | null;
  tags: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  is_deleted: number; // 0 | 1
}

export interface PendingOp {
  id: number;
  op_type: string;
  task_id: string;
  payload: string;
  created_at: string;
  retry_count: number;
  last_error: string | null;
}

let db: Database.Database;

export function initDB(dbPath?: string): void {
  const resolvedPath = dbPath ?? path.join(app.getPath('userData'), 'kanban.db');
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate();
}

export function switchDB(newPath: string): void {
  try { db?.close(); } catch { /* ignore */ }
  db = new Database(newPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate();
}

export interface TagOption {
  name: string;
  color: string | null;
}

export interface StatusOption {
  name: string;
  color: string | null;
  position: number;
  airtable_choice_id: string | null;
}

export interface Collaborator {
  user_id: string;
  email: string | null;
  name: string | null;
  airtable_id: string | null;
}

function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tag_options (
      name  TEXT PRIMARY KEY,
      color TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      title       TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'Not Started',
      priority    TEXT,
      due_date    TEXT,
      assigned_to TEXT,
      tags        TEXT,
      position    REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      synced_at   TEXT,
      is_deleted  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS collaborators (
      user_id     TEXT PRIMARY KEY,
      email       TEXT,
      name        TEXT,
      airtable_id TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS status_options (
      name               TEXT PRIMARY KEY,
      color              TEXT,
      position           REAL NOT NULL DEFAULT 0,
      airtable_choice_id TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_ops (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      op_type     TEXT NOT NULL,
      task_id     TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT
    );
  `);
  seedStatusDefaults();
}

const DEFAULT_STATUSES: Array<{ name: string; color: string; position: number }> = [
  { name: 'Not Started', color: '#97a0af', position: 0 },
  { name: 'In Progress', color: '#0052cc', position: 1000 },
  { name: 'Deferred',    color: '#ff8b00', position: 2000 },
  { name: 'Waiting',     color: '#e5a000', position: 3000 },
  { name: 'Completed',   color: '#00875a', position: 4000 },
];

function seedStatusDefaults(): void {
  const count = db.prepare('SELECT COUNT(*) as c FROM status_options').get() as { c: number };
  if (count.c > 0) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO status_options (name, color, position) VALUES (?, ?, ?)');
  for (const d of DEFAULT_STATUSES) {
    stmt.run(d.name, d.color, d.position);
  }
}

function now(): string {
  return new Date().toISOString();
}

// ── Tasks ──────────────────────────────────────────────────────────────────

export function getAllTasks(): Task[] {
  return db
    .prepare('SELECT * FROM tasks WHERE is_deleted = 0 ORDER BY status, position ASC')
    .all() as Task[];
}

export function getTask(id: string): Task | null {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null;
}

export function getTaskByAirtableId(airtableId: string): Task | null {
  return db
    .prepare('SELECT * FROM tasks WHERE airtable_id = ?')
    .get(airtableId) as Task | null;
}

export function createTask(data: Partial<Task>): Task {
  const status = data.status ?? 'Not Started';
  const maxPosRow = db
    .prepare(
      'SELECT MAX(position) as m FROM tasks WHERE status = ? AND is_deleted = 0',
    )
    .get(status) as { m: number | null };
  const position = data.position ?? (maxPosRow.m ?? 0) + 1000;

  const task: Task = {
    id: data.id ?? randomUUID(),
    airtable_id: data.airtable_id ?? null,
    title: data.title ?? 'Untitled',
    description: data.description ?? '',
    status,
    priority: data.priority ?? null,
    due_date: data.due_date ?? null,
    assigned_to: data.assigned_to ?? null,
    tags: data.tags ?? null,
    position,
    created_at: data.created_at ?? now(),
    updated_at: data.updated_at ?? now(),
    synced_at: data.synced_at ?? null,
    is_deleted: 0,
  };

  db.prepare(`
    INSERT OR REPLACE INTO tasks
      (id, airtable_id, title, description, status, priority, due_date,
       assigned_to, tags, position, created_at, updated_at, synced_at, is_deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    task.id, task.airtable_id, task.title, task.description, task.status,
    task.priority, task.due_date, task.assigned_to, task.tags, task.position,
    task.created_at, task.updated_at, task.synced_at, task.is_deleted,
  );
  return task;
}

export function updateTask(id: string, updates: Partial<Task>): Task | null {
  const existing = getTask(id);
  if (!existing) return null;

  const merged: Task = { ...existing, ...updates, id: existing.id, updated_at: now() };

  db.prepare(`
    UPDATE tasks SET
      title = ?, description = ?, status = ?, priority = ?, due_date = ?,
      assigned_to = ?, tags = ?, position = ?, updated_at = ?,
      airtable_id = ?, synced_at = ?
    WHERE id = ?
  `).run(
    merged.title, merged.description, merged.status, merged.priority, merged.due_date,
    merged.assigned_to, merged.tags, merged.position, merged.updated_at,
    merged.airtable_id, merged.synced_at, merged.id,
  );
  return merged;
}

export function softDeleteTask(id: string): void {
  db.prepare('UPDATE tasks SET is_deleted = 1, updated_at = ? WHERE id = ?').run(now(), id);
}

export function hardDeleteTask(id: string): void {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function getMaxPosition(status: string): number {
  const row = db
    .prepare('SELECT MAX(position) as m FROM tasks WHERE status = ? AND is_deleted = 0')
    .get(status) as { m: number | null };
  return row.m ?? 0;
}

// ── Pending Ops ────────────────────────────────────────────────────────────

export function getPendingOps(): PendingOp[] {
  return db.prepare('SELECT * FROM pending_ops ORDER BY id ASC').all() as PendingOp[];
}

export function getPendingOpByTaskAndType(taskId: string, opType: string): PendingOp | null {
  return db
    .prepare('SELECT * FROM pending_ops WHERE task_id = ? AND op_type = ?')
    .get(taskId, opType) as PendingOp | null;
}

export function addPendingOp(op: { op_type: string; task_id: string; payload: string }): number {
  const result = db
    .prepare(
      'INSERT INTO pending_ops (op_type, task_id, payload, created_at, retry_count) VALUES (?,?,?,?,0)',
    )
    .run(op.op_type, op.task_id, op.payload, now());
  return result.lastInsertRowid as number;
}

export function updatePendingOpPayload(id: number, payload: string): void {
  db.prepare('UPDATE pending_ops SET payload = ? WHERE id = ?').run(payload, id);
}

export function deletePendingOp(id: number): void {
  db.prepare('DELETE FROM pending_ops WHERE id = ?').run(id);
}

export function deletePendingOpsByTaskId(taskId: string): void {
  db.prepare('DELETE FROM pending_ops WHERE task_id = ?').run(taskId);
}

export function incrementPendingOpRetry(id: number, error: string): void {
  db.prepare(
    'UPDATE pending_ops SET retry_count = retry_count + 1, last_error = ? WHERE id = ?',
  ).run(error, id);
}

// ── Tag Options ────────────────────────────────────────────────────────────

export function getTagOptions(): TagOption[] {
  return db.prepare('SELECT name, color FROM tag_options ORDER BY name ASC').all() as TagOption[];
}

export function replaceTagOptions(options: TagOption[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tag_options').run();
    const stmt = db.prepare('INSERT INTO tag_options (name, color) VALUES (?, ?)');
    for (const opt of options) {
      stmt.run(opt.name, opt.color);
    }
  });
  tx();
}

// ── Status Options ─────────────────────────────────────────────────────

export const STATUS_COLOR_PALETTE = [
  '#97a0af', '#0052cc', '#ff8b00', '#e5a000', '#00875a',
  '#6554c0', '#ff5630', '#00b8d9', '#ff991f', '#36b37e',
  '#8777d9', '#ff7452', '#00c7e6', '#ffc400', '#57d9a3',
];

export function getStatusOptions(): StatusOption[] {
  return db.prepare('SELECT name, color, position, airtable_choice_id FROM status_options ORDER BY position ASC').all() as StatusOption[];
}

export function replaceStatusOptions(options: StatusOption[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM status_options').run();
    const stmt = db.prepare('INSERT INTO status_options (name, color, position, airtable_choice_id) VALUES (?, ?, ?, ?)');
    for (const opt of options) {
      stmt.run(opt.name, opt.color, opt.position, opt.airtable_choice_id);
    }
  });
  tx();
}

export function addStatusOption(name: string, color: string | null, position: number): void {
  db.prepare('INSERT OR IGNORE INTO status_options (name, color, position) VALUES (?, ?, ?)').run(name, color, position);
}

export function renameStatusOption(oldName: string, newName: string): void {
  const n = now();
  const tx = db.transaction(() => {
    const old = db.prepare('SELECT color, position, airtable_choice_id FROM status_options WHERE name = ?')
      .get(oldName) as { color: string | null; position: number; airtable_choice_id: string | null } | undefined;
    if (!old) return;
    db.prepare('INSERT OR REPLACE INTO status_options (name, color, position, airtable_choice_id) VALUES (?, ?, ?, ?)')
      .run(newName, old.color, old.position, old.airtable_choice_id);
    db.prepare('DELETE FROM status_options WHERE name = ?').run(oldName);
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE status = ?').run(newName, n, oldName);
  });
  tx();
}

export function removeStatusOption(name: string, moveToStatus: string): void {
  const n = now();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM status_options WHERE name = ?').run(name);
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE status = ?').run(moveToStatus, n, name);
  });
  tx();
}

export function reorderStatusOptions(orderedNames: string[]): void {
  const tx = db.transaction(() => {
    const stmt = db.prepare('UPDATE status_options SET position = ? WHERE name = ?');
    orderedNames.forEach((name, idx) => {
      stmt.run(idx * 1000, name);
    });
  });
  tx();
}

export function getMaxStatusPosition(): number {
  const row = db.prepare('SELECT MAX(position) as m FROM status_options').get() as { m: number | null };
  return row.m ?? 0;
}

export function bulkRenameTaskStatus(oldStatus: string, newStatus: string): void {
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE status = ?').run(newStatus, now(), oldStatus);
}

export function getTaskCountByStatus(status: string): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ? AND is_deleted = 0').get(status) as { c: number };
  return row.c;
}

// ── Collaborators ──────────────────────────────────────────────────────

export function getCollaborators(): Collaborator[] {
  return db.prepare('SELECT user_id, email, name, airtable_id FROM collaborators ORDER BY name ASC').all() as Collaborator[];
}

export function upsertCollaborator(c: Collaborator): void {
  db.prepare(`
    INSERT INTO collaborators (user_id, email, name, airtable_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = COALESCE(excluded.email, collaborators.email),
      name = COALESCE(excluded.name, collaborators.name),
      airtable_id = COALESCE(excluded.airtable_id, collaborators.airtable_id)
  `).run(c.user_id, c.email, c.name, c.airtable_id);
}

export function replaceCollaborators(collaborators: Collaborator[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM collaborators').run();
    const stmt = db.prepare('INSERT INTO collaborators (user_id, email, name, airtable_id) VALUES (?, ?, ?, ?)');
    for (const c of collaborators) {
      stmt.run(c.user_id, c.email, c.name, c.airtable_id);
    }
  });
  tx();
}

// ── Settings ───────────────────────────────────────────────────────────────

export function getSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, value);
}
