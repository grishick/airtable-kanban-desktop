import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import * as db from './db';
import { SyncEngine } from './sync';
import {
  loadAccountsFile,
  getActiveAccount,
  getActiveToken,
  dbPathForAccount,
  addAccount,
  updateAccount,
  deleteAccount,
  setActiveAccount,
  AccountsFile,
} from './accounts';
import { AirtableClient, fetchBaseName, fetchBases, fetchTables } from './airtable';
import { startOAuthFlow } from './oauth';

const isDev = process.env.NODE_ENV === 'development';
let syncEngine: SyncEngine | null = null;
let oauthAbortController: AbortController | null = null;

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

function broadcastAccounts(win: BrowserWindow, file: AccountsFile): void {
  if (!win.isDestroyed()) {
    win.webContents.send('accounts:updated', { accounts: file.accounts, activeId: file.activeId });
  }
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

    const pendingCreate = db.getPendingOpByTaskAndType(id, 'create');
    if (pendingCreate) {
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
  });

  // ── Settings ───────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => {
    const stored = db.getSettings();
    return {
      link_open_target: stored['link_open_target'] ?? 'browser',
      page_size: stored['page_size'] ? parseInt(stored['page_size'], 10) : 10,
      sync_interval_seconds: stored['sync_interval_seconds'] ? parseInt(stored['sync_interval_seconds'], 10) : 60,
      oauth_lambda_url: stored['oauth_lambda_url'] ?? 'https://airtable-kanban.widgeterian.com',
      app_version: app.getVersion(),
    };
  });

  ipcMain.handle('settings:save', (_event, settings: Record<string, string | number>) => {
    if (settings.link_open_target !== undefined) {
      db.setSetting('link_open_target', String(settings.link_open_target));
    }
    if (settings.page_size !== undefined) {
      db.setSetting('page_size', String(settings.page_size));
    }
    if (settings.sync_interval_seconds !== undefined) {
      db.setSetting('sync_interval_seconds', String(settings.sync_interval_seconds));
      syncEngine?.setInterval(Number(settings.sync_interval_seconds));
    }
    if (settings.oauth_lambda_url !== undefined) {
      db.setSetting('oauth_lambda_url', String(settings.oauth_lambda_url));
    }
    syncEngine?.reinit();
    if (syncEngine) void syncEngine.sync();
  });

  // ── Accounts ───────────────────────────────────────────────────────────
  ipcMain.handle('accounts:list', () => {
    const { accounts, activeId } = loadAccountsFile();
    return { accounts, activeId };
  });

  ipcMain.handle('accounts:add', async (_event, data: {
    name?: string;
    authType?: 'pat' | 'oauth';
    token?: string;
    oauthAccessToken?: string;
    oauthRefreshToken?: string;
    oauthTokenExpiresAt?: string;
    baseId: string;
    tableName: string;
    collaboratorsTableName?: string;
  }) => {
    const isFirstAccount = getActiveAccount() === null;

    const tokenForName = data.authType === 'oauth'
      ? (data.oauthAccessToken ?? '')
      : (data.token ?? '');

    let name = data.name?.trim();
    if (!name && tokenForName) {
      const baseName = await fetchBaseName(tokenForName, data.baseId);
      name = baseName ?? 'New Account';
    }
    name = name || 'New Account';
    // If tokenForName is empty, auto-derivation is silently skipped — intentional.

    const { file } = addAccount({
      name,
      authType: data.authType ?? 'pat',
      token: data.token,
      oauthAccessToken: data.oauthAccessToken,
      oauthRefreshToken: data.oauthRefreshToken,
      oauthTokenExpiresAt: data.oauthTokenExpiresAt,
      baseId: data.baseId,
      tableName: data.tableName || 'Tasks',
      collaboratorsTableName: data.collaboratorsTableName || 'Collaborators',
    });

    if (isFirstAccount) {
      const newActive = getActiveAccount()!;
      db.switchDB(dbPathForAccount(newActive.id));
      syncEngine?.reinit();
      if (!win.isDestroyed()) win.webContents.send('tasks:updated', db.getAllTasks());
      if (syncEngine) void syncEngine.sync();
    }

    broadcastAccounts(win, file);
    return { accounts: file.accounts, activeId: file.activeId };
  });

  ipcMain.handle('accounts:update', (_event, id: string, updates: {
    name?: string;
    token?: string;
    oauthAccessToken?: string;
    oauthRefreshToken?: string;
    oauthTokenExpiresAt?: string;
    baseId?: string;
    tableName?: string;
    collaboratorsTableName?: string;
  }) => {
    const result = updateAccount(id, updates);
    if (!result) throw new Error(`Account not found: ${id}`);

    // Reinit sync if active account credentials changed
    const { activeId } = result.file;
    if (id === activeId && (updates.token || updates.oauthAccessToken || updates.baseId || updates.tableName || updates.collaboratorsTableName)) {
      syncEngine?.reinit();
      if (syncEngine) void syncEngine.sync();
    }

    broadcastAccounts(win, result.file);
    return { accounts: result.file.accounts, activeId: result.file.activeId };
  });

  ipcMain.handle('accounts:delete', (_event, id: string) => {
    const prevActive = getActiveAccount();
    const file = deleteAccount(id);

    // Delete the account's DB file
    try { fs.unlinkSync(dbPathForAccount(id)); } catch { /* file may not exist */ }

    // If the deleted account was active, switch to the new active one
    if (prevActive?.id === id) {
      const newActive = getActiveAccount();
      const newDbPath = newActive
        ? dbPathForAccount(newActive.id)
        : path.join(app.getPath('userData'), 'kanban.db');
      db.switchDB(newDbPath);
      syncEngine?.reinit();
      if (!win.isDestroyed()) {
        win.webContents.send('tasks:updated', db.getAllTasks());
        win.webContents.send('sync:status', syncEngine?.getStatus() ?? {
          state: 'unconfigured', lastSync: null, error: null, pendingOps: 0,
        });
      }
      if (syncEngine && newActive) void syncEngine.sync();
    }

    broadcastAccounts(win, file);
    return { accounts: file.accounts, activeId: file.activeId };
  });

  ipcMain.handle('accounts:switch', (_event, id: string) => {
    const file = setActiveAccount(id);
    db.switchDB(dbPathForAccount(id));
    syncEngine?.reinit();
    if (!win.isDestroyed()) {
      win.webContents.send('tasks:updated', db.getAllTasks());
      win.webContents.send('sync:status', syncEngine!.getStatus());
    }
    if (syncEngine) void syncEngine.sync();
    broadcastAccounts(win, file);
    return { accounts: file.accounts, activeId: id };
  });

  // ── Sync ───────────────────────────────────────────────────────────────
  ipcMain.handle('sync:trigger', async () => {
    if (syncEngine) await syncEngine.sync();
  });

  ipcMain.handle('airtable:createTable', async () => {
    if (syncEngine) await syncEngine.createTable();
  });

  ipcMain.handle('airtable:listBases', async (_event, { token }: { token: string }) => {
    return fetchBases(token);
  });

  ipcMain.handle('airtable:listTables', async (_event, { token, baseId }: { token: string; baseId: string }) => {
    return fetchTables(token, baseId);
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

  // ── Collaborators ─────────────────────────────────────────────────────
  ipcMain.handle('collaborators:get', () => {
    return db.getCollaborators();
  });

  ipcMain.handle('collaborators:invite', async (_event, email: string, permissionLevel: string) => {
    const account = getActiveAccount();
    const token = account ? getActiveToken(account) : '';
    const baseId = account?.baseId ?? '';
    if (!token || !baseId) throw new Error('Airtable not configured');

    const client = new AirtableClient(token, baseId, account?.tableName ?? 'Tasks');
    await client.inviteCollaborator(email, permissionLevel);
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

  // ── OAuth ──────────────────────────────────────────────────────────────
  ipcMain.handle('accounts:startOAuth', async () => {
    if (oauthAbortController) {
      throw new Error('An OAuth flow is already in progress');
    }
    const lambdaUrl = db.getSettings()['oauth_lambda_url'] ?? '';
    if (!lambdaUrl) throw new Error('OAuth Lambda URL is not configured in App Settings');

    oauthAbortController = new AbortController();
    try {
      return await startOAuthFlow(lambdaUrl, oauthAbortController.signal);
    } finally {
      oauthAbortController = null;
    }
  });

  ipcMain.handle('accounts:cancelOAuth', () => {
    oauthAbortController?.abort();
    oauthAbortController = null;
  });
}

app.whenReady().then(() => {
  // Open the active account's DB, or fall back to the legacy kanban.db
  const activeAccount = getActiveAccount();
  const dbPath = activeAccount
    ? dbPathForAccount(activeAccount.id)
    : path.join(app.getPath('userData'), 'kanban.db');

  try {
    db.initDB(dbPath);
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
  const savedInterval = db.getSettings()['sync_interval_seconds'];
  if (savedInterval) syncEngine.setInterval(parseInt(savedInterval, 10));
  syncEngine.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  syncEngine?.stop();
  if (process.platform !== 'darwin') app.quit();
});
