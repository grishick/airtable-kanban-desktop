import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import * as db from './db';
import { SyncEngine } from './sync';

const isDev = process.env.NODE_ENV === 'development';
let syncEngine: SyncEngine | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#f0f2f5',
    title: 'Airtable Kanban Desktop',
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Cmd/Ctrl+Shift+I opens DevTools in any mode
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'I' && input.shift && (input.meta || input.control)) {
      win.webContents.toggleDevTools();
    }
  });

  return win;
}

function setupIPC(win: BrowserWindow): void {
  // ── Tasks ──────────────────────────────────────────────────────────────
  ipcMain.handle('tasks:get', () => {
    return db.getAllTasks();
  });

  ipcMain.handle('tasks:create', (_event, taskData: Partial<db.Task>) => {
    const task = db.createTask(taskData);
    db.addPendingOp({ op_type: 'create', task_id: task.id, payload: JSON.stringify(task) });
    return task;
  });

  ipcMain.handle('tasks:update', (_event, id: string, updates: Partial<db.Task>) => {
    const task = db.updateTask(id, updates);
    if (!task) throw new Error(`Task not found: ${id}`);

    // Coalesce into existing pending op for this task when possible
    const pendingCreate = db.getPendingOpByTaskAndType(id, 'create');
    if (pendingCreate) {
      // Refresh the create payload so sync sends latest state
      db.updatePendingOpPayload(pendingCreate.id, JSON.stringify(task));
    } else {
      const pendingUpdate = db.getPendingOpByTaskAndType(id, 'update');
      if (pendingUpdate) {
        db.updatePendingOpPayload(pendingUpdate.id, JSON.stringify(updates));
      } else {
        db.addPendingOp({ op_type: 'update', task_id: id, payload: JSON.stringify(updates) });
      }
    }
    return task;
  });

  ipcMain.handle('tasks:delete', (_event, id: string) => {
    const task = db.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    db.softDeleteTask(id);
    db.deletePendingOpsByTaskId(id);

    if (task.airtable_id) {
      db.addPendingOp({
        op_type: 'delete',
        task_id: id,
        payload: JSON.stringify({ airtable_id: task.airtable_id }),
      });
    }
    // Task never reached Airtable — just remove from pending and leave soft-deleted
  });

  // ── Settings ───────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => {
    const stored = db.getSettings();
    // Merge env-var defaults (stored values win over env)
    return {
      airtable_access_token:
        stored['airtable_access_token'] ?? '',
      airtable_base_id:
        stored['airtable_base_id'] ?? '',
      airtable_table_name:
        stored['airtable_table_name'] ?? 'Tasks',
      link_open_target:
        stored['link_open_target'] ?? 'browser',
      page_size:
        stored['page_size'] ? parseInt(stored['page_size'], 10) : 10,
    };
  });

  ipcMain.handle('settings:save', (_event, settings: Record<string, string>) => {
    for (const [key, value] of Object.entries(settings)) {
      db.setSetting(key, String(value));
    }
    syncEngine?.reinit();
    // Trigger an immediate sync so the renderer learns about table state without waiting 30s
    if (syncEngine) void syncEngine.sync();
  });

  // ── Sync ───────────────────────────────────────────────────────────────
  ipcMain.handle('sync:trigger', async () => {
    if (syncEngine) await syncEngine.sync();
  });

  ipcMain.handle('airtable:createTable', async () => {
    if (syncEngine) await syncEngine.createTable();
  });

  ipcMain.handle('sync:status', () => {
    return syncEngine?.getStatus() ?? {
      state: 'idle',
      lastSync: null,
      error: null,
      pendingOps: 0,
    };
  });

  // ── Shell ──────────────────────────────────────────────────────────────
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    shell.openExternal(url);
  });

  ipcMain.handle('shell:openLink', (_event, url: string) => {
    const settings = db.getSettings();
    const target = settings['link_open_target'] ?? 'browser';
    if (target === 'app') {
      const linkWin = new BrowserWindow({
        width: 1200,
        height: 800,
        title: url,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      linkWin.loadURL(url);
    } else {
      shell.openExternal(url);
    }
  });

  // ── Tag Options ────────────────────────────────────────────────────────
  ipcMain.handle('tags:getOptions', () => {
    return db.getTagOptions();
  });

  // ── Error dialog ───────────────────────────────────────────────────────
  ipcMain.handle('error:show', async (_event, title: string, detail: string) => {
    await dialog.showMessageBox(win, {
      type: 'error',
      title,
      message: title,
      detail,
      buttons: ['OK'],
    });
  });
}

app.whenReady().then(() => {
  try {
    db.initDB();
  } catch (err) {
    dialog.showErrorBox(
      'Database Error',
      `Failed to open local database:\n${err}\n\nTry running: npm run rebuild`,
    );
    app.quit();
    return;
  }

  const win = createWindow();
  setupIPC(win);
  syncEngine = new SyncEngine(win);
  syncEngine.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  syncEngine?.stop();
  if (process.platform !== 'darwin') app.quit();
});
