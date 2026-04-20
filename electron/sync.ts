import { BrowserWindow, powerSaveBlocker } from 'electron';
import * as db from './db';
import { AirtableClient, AirtableCollaborator, AirtableFields, AirtableRecord } from './airtable';
import { getActiveAccount, getActiveToken, refreshOAuthTokenIfNeeded } from './accounts';

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline' | 'unconfigured' | 'table_not_found';

export interface SyncStatus {
  state: SyncState;
  lastSync: string | null;
  error: string | null;
  pendingOps: number;
}

const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const MAX_RETRIES = 5;

export class SyncEngine {
  private client: AirtableClient | null = null;
  private state: SyncState = 'idle';
  private lastSync: string | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private positionFieldEnsured = false;
  private assigneeFieldEnsured = false;
  private createdByFieldEnsured = false;
  private harvestedCollaborators = new Map<string, AirtableCollaborator>();
  private powerSaveId: number | null = null;
  private intervalMs = DEFAULT_SYNC_INTERVAL_MS;
  /** Ensures only one sync cycle runs at a time (interval + manual triggers). */
  private syncTail: Promise<void> = Promise.resolve();

  constructor(private win: BrowserWindow) {
    this.reinit();
  }

  /** Point status/task broadcasts at the current renderer window (e.g. after macOS closes and reopens the window). */
  setBroadcastWindow(win: BrowserWindow): void {
    this.win = win;
  }

  /** Re-read active account and recreate the Airtable client. */
  reinit(): void {
    const account = getActiveAccount();
    const token = account ? getActiveToken(account) : '';
    const baseId = account?.baseId ?? '';
    const tableName = account?.tableName ?? 'Tasks';

    if (token && baseId) {
      this.client = new AirtableClient(token, baseId, tableName);
      if (this.state === 'unconfigured') this.state = 'idle';
    } else {
      this.client = null;
      this.state = 'unconfigured';
    }
    this.positionFieldEnsured = false;
    this.assigneeFieldEnsured = false;
    this.createdByFieldEnsured = false;
    this.broadcastStatus();
  }

  /** Begin periodic sync loop. */
  start(): void {
    if (this.startupTimer !== null || this.timer !== null) {
      return;
    }
    if (this.powerSaveId === null) {
      this.powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sync();
      this.timer = setInterval(() => void this.sync(), this.intervalMs);
    }, 3000);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.powerSaveId !== null) {
      powerSaveBlocker.stop(this.powerSaveId);
      this.powerSaveId = null;
    }
  }

  /** Update the sync interval. Restarts the timer if already running. */
  setInterval(seconds: number): void {
    this.intervalMs = Math.max(10, seconds) * 1000;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.sync(), this.intervalMs);
    }
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

  private broadcastCollaborators(): void {
    this.broadcast('collaborators:updated', db.getCollaborators());
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

  /** Public entry point: run one full sync cycle (serialized — overlapping calls queue). */
  sync(): Promise<void> {
    const run = this.syncTail.then(() => this.performSync());
    this.syncTail = run.catch(() => {
      /* Errors are stored in sync state; keep the queue unbroken. */
    });
    return run;
  }

  private async performSync(): Promise<void> {
    // Refresh OAuth token if needed before attempting sync
    const activeAccount = getActiveAccount();
    if (activeAccount?.authType === 'oauth') {
      try {
        const lambdaUrl = db.getSettings()['oauth_lambda_url'] ?? '';
        await refreshOAuthTokenIfNeeded(activeAccount, lambdaUrl);
        this.reinit(); // re-reads accounts.json which now has the fresh token
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = `Re-authentication required: ${msg}`;
        this.state = 'unconfigured';
        this.broadcastStatus();
        return;
      }
    }

    if (!this.client) {
      this.state = 'unconfigured';
      this.broadcastStatus();
      return;
    }

    this.state = 'syncing';
    this.broadcastStatus();

    try {
      await this.ensurePositionField();
      await this.ensureAssigneeField();
      await this.ensureCreatedByField();
      this.harvestedCollaborators.clear();
      await this.pushPendingOps();
      await this.pullFromAirtable();
      await this.updateTagOptions();
      await this.updateStatusOptions();
      await this.syncCollaborators();
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
    this.broadcastStatusOptions();
    this.broadcastCollaborators();
  }

  // ── Schema migration ──────────────────────────────────────────────────

  private async ensurePositionField(): Promise<void> {
    if (this.positionFieldEnsured || !this.client) return;
    try {
      await this.client.ensurePositionField();
      this.positionFieldEnsured = true;
    } catch (err) {
      console.warn('[sync] failed to ensure Position field:', err);
    }
  }

  private async ensureAssigneeField(): Promise<void> {
    if (this.assigneeFieldEnsured || !this.client) return;
    try {
      await this.client.ensureAssigneeField();
      this.assigneeFieldEnsured = true;
    } catch (err) {
      console.warn('[sync] failed to ensure Assignee field:', err);
    }
  }

  private async ensureCreatedByField(): Promise<void> {
    if (this.createdByFieldEnsured || !this.client) return;
    try {
      await this.client.ensureCreatedByField();
      this.createdByFieldEnsured = true;
    } catch (err) {
      console.warn('[sync] failed to ensure Created By field:', err);
    }
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

  // ── Status Options ─────────────────────────────────────────────────────

  private broadcastStatusOptions(): void {
    this.broadcast('statuses:updated', db.getStatusOptions());
  }

  private async updateStatusOptions(): Promise<void> {
    try {
      const remoteChoices = await this.client!.fetchStatusOptions();
      if (remoteChoices.length === 0) return;

      const local = db.getStatusOptions();
      const localByName = new Map<string, db.StatusOption>();
      const localByChoiceId = new Map<string, db.StatusOption>();
      for (const opt of local) {
        localByName.set(opt.name, opt);
        if (opt.airtable_choice_id) localByChoiceId.set(opt.airtable_choice_id, opt);
      }

      const result: db.StatusOption[] = [];
      const matchedLocalNames = new Set<string>();
      const handledRemoteNames = new Set<string>();
      let maxPos = local.reduce((m, o) => Math.max(m, o.position), -1000);
      const usedColors = new Set(local.map((o) => o.color).filter(Boolean));

      // Pass 1: match remote choices by NAME (highest priority — handles
      // local renames where the choice ID still points to the old Airtable
      // choice but tasks already use the new name).
      for (const rc of remoteChoices) {
        const byName = localByName.get(rc.name);
        if (byName) {
          matchedLocalNames.add(rc.name);
          handledRemoteNames.add(rc.name);
          result.push({
            name: rc.name,
            color: byName.color,
            position: byName.position,
            airtable_choice_id: rc.id ?? byName.airtable_choice_id,
          });
        }
      }

      // Pass 2: for remote choices not matched by name, try matching by
      // choice ID. This detects upstream renames made in Airtable.
      for (const rc of remoteChoices) {
        if (handledRemoteNames.has(rc.name)) continue;

        const byId = rc.id ? localByChoiceId.get(rc.id) : undefined;
        if (byId && !matchedLocalNames.has(byId.name)) {
          // ID match with different name — upstream rename from Airtable
          matchedLocalNames.add(byId.name);
          handledRemoteNames.add(rc.name);
          db.bulkRenameTaskStatus(byId.name, rc.name);
          result.push({
            name: rc.name,
            color: byId.color,
            position: byId.position,
            airtable_choice_id: rc.id ?? null,
          });
        } else if (!byId) {
          handledRemoteNames.add(rc.name);
          // Completely new Airtable choice — only add if tasks use it
          if (db.getTaskCountByStatus(rc.name) === 0) continue;
          maxPos += 1000;
          const color = db.STATUS_COLOR_PALETTE.find((c) => !usedColors.has(c))
            ?? db.STATUS_COLOR_PALETTE[result.length % db.STATUS_COLOR_PALETTE.length];
          usedColors.add(color);
          result.push({
            name: rc.name,
            color,
            position: maxPos,
            airtable_choice_id: rc.id ?? null,
          });
        }
        // If byId matched but its name was already claimed in pass 1,
        // this is a stale Airtable choice left over from a local rename — skip it.
      }

      // Keep local-only statuses (not in Airtable, e.g. newly added locally)
      for (const opt of local) {
        if (!matchedLocalNames.has(opt.name)) {
          result.push(opt);
        }
      }

      db.replaceStatusOptions(result);
    } catch (err) {
      console.warn('[sync] failed to update status options:', err);
    }
  }

  // ── Collaborators ──────────────────────────────────────────────────────

  private harvestCollaborator(c: AirtableCollaborator | null | undefined): void {
    if (!c?.id) return;
    this.harvestedCollaborators.set(c.id, c);
  }

  private async syncCollaborators(): Promise<void> {
    if (!this.client) return;

    const account = getActiveAccount();
    const collabTableName = account?.collaboratorsTableName || 'Collaborators';

    const merged = new Map<string, db.Collaborator>();
    for (const [id, c] of this.harvestedCollaborators) {
      merged.set(id, {
        user_id: id,
        email: c.email ?? null,
        name: c.name ?? null,
        airtable_id: null,
      });
    }

    try {
      const remoteRecords = await this.client.fetchCollaboratorsTable(collabTableName);
      for (const rec of remoteRecords) {
        const userId = rec.fields['User ID'] as string | undefined;
        if (!userId) continue;
        const existing = merged.get(userId);
        merged.set(userId, {
          user_id: userId,
          email: (rec.fields.Email as string) || existing?.email || null,
          name: (rec.fields.Name as string) || existing?.name || null,
          airtable_id: rec.id,
        });
      }

      const toPush = [...merged.values()].filter((c) => !c.airtable_id);
      if (toPush.length > 0) {
        try {
          const created = await this.client.pushCollaboratorsToTable(
            collabTableName,
            toPush.map((c) => ({ userId: c.user_id, email: c.email, name: c.name })),
          );
          for (let i = 0; i < toPush.length && i < created.length; i++) {
            toPush[i].airtable_id = created[i].id;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('TABLE_NOT_FOUND') || msg.includes('INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND') || msg.includes('404')) {
            try {
              await this.client.createCollaboratorsTable(collabTableName);
              const created = await this.client.pushCollaboratorsToTable(
                collabTableName,
                toPush.map((c) => ({ userId: c.user_id, email: c.email, name: c.name })),
              );
              for (let i = 0; i < toPush.length && i < created.length; i++) {
                toPush[i].airtable_id = created[i].id;
              }
            } catch (createErr) {
              console.warn('[sync] failed to create collaborators table:', createErr);
            }
          } else {
            console.warn('[sync] failed to push collaborators:', err);
          }
        }
      }
    } catch (err) {
      console.warn('[sync] failed to sync collaborators table:', err);
    }

    if (merged.size > 0) {
      db.replaceCollaborators([...merged.values()]);
    }
  }

  // ── Pull ───────────────────────────────────────────────────────────────

  private async pullFromAirtable(): Promise<void> {
    const records = await this.client!.fetchAllRecords();
    const pendingTaskIds = new Set(db.getPendingOps().map((op) => op.task_id));
    const needsPositionBackfill: { id: string; fields: AirtableFields }[] = [];

    for (const record of records) {
      this.harvestCollaborator(record.fields['Created By'] as AirtableCollaborator | undefined);
      this.harvestCollaborator(record.fields.Assignee as AirtableCollaborator | undefined);

      const existing = db.getTaskByAirtableId(record.id);
      const hasRemotePosition = typeof record.fields.Position === 'number';

      if (existing) {
        if (pendingTaskIds.has(existing.id)) continue;
        db.updateTask(existing.id, {
          ...airtableToTaskFields(record),
          synced_at: new Date().toISOString(),
        });
        if (!hasRemotePosition) {
          needsPositionBackfill.push({
            id: record.id,
            fields: { Position: existing.position },
          });
        }
      } else {
        const fields = airtableToTaskFields(record);
        const position = fields.position ?? db.getMaxPosition(fields.status ?? 'Not Started') + 1000;
        db.createTask({ ...fields, position, airtable_id: record.id });
        if (!hasRemotePosition) {
          needsPositionBackfill.push({
            id: record.id,
            fields: { Position: position },
          });
        }
      }
    }

    if (needsPositionBackfill.length > 0 && this.client) {
      try {
        await this.client.updateRecords(needsPositionBackfill);
      } catch (err) {
        console.warn('[sync] position backfill failed:', err);
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function taskToFields(task: db.Task): AirtableFields {
  const fields: AirtableFields = {
    'Task Name': task.title,
    Status: task.status,
    Position: task.position,
  };
  if (task.description) fields.Description = task.description;
  if (task.priority) fields.Priority = task.priority;
  if (task.due_date) fields['Due Date'] = task.due_date;
  if (task.tags) fields.Tags = task.tags.split(',').map((t) => t.trim()).filter(Boolean);
  if (task.assigned_to) {
    try {
      const parsed = JSON.parse(task.assigned_to) as AirtableCollaborator;
      if (parsed?.id) fields.Assignee = { id: parsed.id };
    } catch { /* ignore invalid JSON */ }
  } else {
    fields.Assignee = null;
  }
  return fields;
}

function airtableToTaskFields(record: AirtableRecord): Partial<db.Task> {
  const f = record.fields;
  const tags = Array.isArray(f.Tags)
    ? f.Tags.join(', ')
    : (f.Tags as string | undefined) ?? null;

  const assignee = f.Assignee as AirtableCollaborator | null | undefined;
  const assignedTo = assignee?.id
    ? JSON.stringify({ id: assignee.id, email: assignee.email ?? null, name: assignee.name ?? null })
    : null;

  const fields: Partial<db.Task> = {
    title: (f['Task Name'] as string | undefined) ?? 'Untitled',
    description: (f.Description as string | undefined) ?? '',
    status: (f.Status as string | undefined) ?? 'Not Started',
    priority: (f.Priority as string | undefined) ?? null,
    due_date: (f['Due Date'] as string | undefined) ?? null,
    tags,
    assigned_to: assignedTo,
  };
  if (typeof f.Position === 'number') fields.position = f.Position;
  return fields;
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
