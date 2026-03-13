import { BrowserWindow } from 'electron';
import * as db from './db';
import { AirtableClient, AirtableFields, AirtableRecord } from './airtable';

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline' | 'unconfigured' | 'table_not_found';

export interface SyncStatus {
  state: SyncState;
  lastSync: string | null;
  error: string | null;
  pendingOps: number;
}

const SYNC_INTERVAL_MS = 30_000;
const MAX_RETRIES = 5;

export class SyncEngine {
  private client: AirtableClient | null = null;
  private state: SyncState = 'idle';
  private lastSync: string | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private win: BrowserWindow) {
    this.reinit();
  }

  /** Re-read settings and recreate the Airtable client. */
  reinit(): void {
    const s = db.getSettings();
    const token = s['airtable_access_token'] ?? '';
    const baseId = s['airtable_base_id'] ?? '';
    const tableName = s['airtable_table_name'] ?? 'Tasks';

    if (token && baseId) {
      this.client = new AirtableClient(token, baseId, tableName);
      if (this.state === 'unconfigured') this.state = 'idle';
    } else {
      this.client = null;
      this.state = 'unconfigured';
    }
    this.broadcastStatus();
  }

  /** Begin periodic sync loop. */
  start(): void {
    // Run first sync soon after startup, then on interval
    this.timer = setTimeout(() => {
      void this.sync();
      this.scheduleLoop();
    }, 3000);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleLoop(): void {
    this.timer = setInterval(() => {
      void this.sync();
    }, SYNC_INTERVAL_MS);
  }

  getStatus(): SyncStatus {
    return {
      state: this.state,
      lastSync: this.lastSync,
      error: this.lastError,
      pendingOps: db.getPendingOps().length,
    };
  }

  private broadcast(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  private broadcastStatus(): void {
    this.broadcast('sync:status', this.getStatus());
  }

  private broadcastTasks(): void {
    this.broadcast('tasks:updated', db.getAllTasks());
  }

  /** Create the Airtable table and immediately run a sync. */
  async createTable(): Promise<void> {
    if (!this.client) throw new Error('Airtable not configured');
    await this.client.createTable();
    this.state = 'idle';
    this.lastError = null;
    this.broadcastStatus();
    await this.sync();
  }

  /** Public entry point: run one full sync cycle. */
  async sync(): Promise<void> {
    if (!this.client) {
      this.state = 'unconfigured';
      this.broadcastStatus();
      return;
    }

    this.state = 'syncing';
    this.broadcastStatus();

    try {
      await this.pushPendingOps();
      await this.pullFromAirtable();
      await this.updateTagOptions();
      this.state = 'idle';
      this.lastSync = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      if (isTableNotFoundError(msg)) {
        this.state = 'table_not_found';
      } else {
        this.state = isNetworkError(msg) ? 'offline' : 'error';
      }
    }

    this.broadcastStatus();
    this.broadcastTasks();
  }

  // ── Push ───────────────────────────────────────────────────────────────

  private async pushPendingOps(): Promise<void> {
    const ops = db.getPendingOps();

    for (const op of ops) {
      if (op.retry_count >= MAX_RETRIES) {
        // Permanently failed — drop it so it never blocks the pending count
        console.error(`[sync] dropping op ${op.id} (${op.op_type} task=${op.task_id}) after ${MAX_RETRIES} retries: ${op.last_error}`);
        db.deletePendingOp(op.id);
        continue;
      }

      try {
        if (op.op_type === 'create') {
          await this.pushCreate(op);
        } else if (op.op_type === 'update') {
          await this.pushUpdate(op);
        } else if (op.op_type === 'delete') {
          await this.pushDelete(op);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.incrementPendingOpRetry(op.id, msg);
        // Re-throw only on network error to abort remaining ops
        if (isNetworkError(msg)) throw err;
      }
    }
  }

  private async pushCreate(op: db.PendingOp): Promise<void> {
    const task = db.getTask(op.task_id);
    if (!task) { db.deletePendingOp(op.id); return; }

    const record = await this.client!.createRecord(taskToFields(task));
    db.updateTask(op.task_id, { airtable_id: record.id, synced_at: new Date().toISOString() });
    db.deletePendingOp(op.id);
  }

  private async pushUpdate(op: db.PendingOp): Promise<void> {
    const task = db.getTask(op.task_id);
    if (!task) { db.deletePendingOp(op.id); return; }
    if (!task.airtable_id) {
      // If there is a pending create for this task, wait for it to succeed first.
      // If there is no pending create, this op can never be pushed — drop it.
      const pendingCreate = db.getPendingOpByTaskAndType(op.task_id, 'create');
      if (!pendingCreate) {
        console.error(`[sync] dropping orphaned update op ${op.id} for task ${op.task_id} (no airtable_id, no pending create)`);
        db.deletePendingOp(op.id);
      }
      return;
    }

    await this.client!.updateRecord(task.airtable_id, taskToFields(task));
    db.updateTask(op.task_id, { synced_at: new Date().toISOString() });
    db.deletePendingOp(op.id);
  }

  private async pushDelete(op: db.PendingOp): Promise<void> {
    const payload = JSON.parse(op.payload) as { airtable_id?: string };
    if (payload.airtable_id) {
      await this.client!.deleteRecord(payload.airtable_id);
    }
    db.hardDeleteTask(op.task_id);
    db.deletePendingOp(op.id);
  }

  // ── Tag Options ────────────────────────────────────────────────────────

  private async updateTagOptions(): Promise<void> {
    try {
      const options = await this.client!.fetchTagOptions();
      if (options.length > 0) {
        db.replaceTagOptions(options);
      }
    } catch (err) {
      // Non-fatal: tag options are a convenience, don't abort sync
      console.warn('[sync] failed to fetch tag options:', err);
    }
  }

  // ── Pull ───────────────────────────────────────────────────────────────

  private async pullFromAirtable(): Promise<void> {
    const records = await this.client!.fetchAllRecords();
    // Tasks with pending ops should not be overwritten by a pull
    const pendingTaskIds = new Set(db.getPendingOps().map((op) => op.task_id));

    for (const record of records) {
      const existing = db.getTaskByAirtableId(record.id);

      if (existing) {
        if (pendingTaskIds.has(existing.id)) continue; // Skip — local changes in queue
        db.updateTask(existing.id, {
          ...airtableToTaskFields(record),
          synced_at: new Date().toISOString(),
        });
      } else {
        // Brand-new record from Airtable
        const fields = airtableToTaskFields(record);
        const position = db.getMaxPosition(fields.status ?? 'Not Started') + 1000;
        db.createTask({ ...fields, position, airtable_id: record.id });
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function taskToFields(task: db.Task): AirtableFields {
  const fields: AirtableFields = {
    'Task Name': task.title,
    Status: task.status,
  };
  if (task.description) fields.Description = task.description;
  if (task.priority) fields.Priority = task.priority;
  if (task.due_date) fields['Due Date'] = task.due_date;
  if (task.tags) fields.Tags = task.tags.split(',').map((t) => t.trim()).filter(Boolean);
  return fields;
}

function airtableToTaskFields(record: AirtableRecord): Partial<db.Task> {
  const f = record.fields;
  const tags = Array.isArray(f.Tags)
    ? f.Tags.join(', ')
    : (f.Tags as string | undefined) ?? null;

  return {
    title: f['Task Name'] ?? 'Untitled',
    description: f.Description ?? '',
    status: f.Status ?? 'Not Started',
    priority: f.Priority ?? null,
    due_date: f['Due Date'] ?? null,
    tags,
  };
}

function isTableNotFoundError(msg: string): boolean {
  return (
    msg.includes('Airtable 404') ||
    msg.includes('TABLE_NOT_FOUND') ||
    // Airtable returns 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND when the
    // table name doesn't exist (it conflates "not found" with "no permission")
    msg.includes('INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND')
  );
}

function isNetworkError(msg: string): boolean {
  return (
    msg.includes('ENOTFOUND') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  );
}
