import { contextBridge, ipcRenderer } from 'electron';

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
  is_deleted: number;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'offline' | 'unconfigured' | 'table_not_found';
  lastSync: string | null;
  error: string | null;
  pendingOps: number;
}

export interface Settings {
  link_open_target?: 'browser' | 'app';
  page_size?: number;
}

export interface Account {
  id: string;
  name: string;
  token: string;
  baseId: string;
  tableName: string;
}

export interface AccountsState {
  accounts: Account[];
  activeId: string | null;
}

export interface TagOption {
  name: string;
  color: string | null;
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Tasks
  getTasks: (): Promise<Task[]> =>
    ipcRenderer.invoke('tasks:get'),
  createTask: (data: Partial<Task>): Promise<Task> =>
    ipcRenderer.invoke('tasks:create', data),
  updateTask: (id: string, updates: Partial<Task>): Promise<Task> =>
    ipcRenderer.invoke('tasks:update', id, updates),
  deleteTask: (id: string): Promise<void> =>
    ipcRenderer.invoke('tasks:delete', id),

  // Settings
  getSettings: (): Promise<Settings> =>
    ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Settings): Promise<void> =>
    ipcRenderer.invoke('settings:save', settings),

  // Accounts
  listAccounts: (): Promise<AccountsState> =>
    ipcRenderer.invoke('accounts:list'),
  addAccount: (data: { name?: string; token: string; baseId: string; tableName: string }): Promise<AccountsState> =>
    ipcRenderer.invoke('accounts:add', data),
  updateAccount: (id: string, updates: { name?: string; token?: string; baseId?: string; tableName?: string }): Promise<AccountsState> =>
    ipcRenderer.invoke('accounts:update', id, updates),
  deleteAccount: (id: string): Promise<AccountsState> =>
    ipcRenderer.invoke('accounts:delete', id),
  switchAccount: (id: string): Promise<AccountsState> =>
    ipcRenderer.invoke('accounts:switch', id),

  // Sync
  triggerSync: (): Promise<void> =>
    ipcRenderer.invoke('sync:trigger'),
  createTable: (): Promise<void> =>
    ipcRenderer.invoke('airtable:createTable'),
  getSyncStatus: (): Promise<SyncStatus> =>
    ipcRenderer.invoke('sync:status'),

  // Shell
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', url),
  openLink: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openLink', url),

  // Tag Options
  getTagOptions: (): Promise<TagOption[]> =>
    ipcRenderer.invoke('tags:getOptions'),

  // Error dialog
  showError: (title: string, detail: string): Promise<void> =>
    ipcRenderer.invoke('error:show', title, detail),

  // Event listeners — return unsubscribe function
  onSyncStatus: (cb: (status: SyncStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: SyncStatus) => cb(status);
    ipcRenderer.on('sync:status', handler);
    return () => ipcRenderer.removeListener('sync:status', handler);
  },
  onTasksUpdated: (cb: (tasks: Task[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tasks: Task[]) => cb(tasks);
    ipcRenderer.on('tasks:updated', handler);
    return () => ipcRenderer.removeListener('tasks:updated', handler);
  },
  onAccountsUpdated: (cb: (state: AccountsState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AccountsState) => cb(state);
    ipcRenderer.on('accounts:updated', handler);
    return () => ipcRenderer.removeListener('accounts:updated', handler);
  },
});
