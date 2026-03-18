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
