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

export type TaskStatus =
  | 'Not Started'
  | 'In Progress'
  | 'Deferred'
  | 'Waiting'
  | 'Completed';

export const STATUSES: TaskStatus[] = [
  'Not Started',
  'In Progress',
  'Deferred',
  'Waiting',
  'Completed',
];

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'offline' | 'unconfigured' | 'table_not_found';
  lastSync: string | null;
  error: string | null;
  pendingOps: number;
}

export interface Settings {
  link_open_target?: 'browser' | 'app';
  page_size?: number;
  oauth_lambda_url?: string;
}

export interface Account {
  id: string;
  name: string;
  authType: 'pat' | 'oauth';     // treated as 'pat' if absent (backwards compat)
  token?: string;                 // PAT only
  oauthAccessToken?: string;      // OAuth only
  oauthRefreshToken?: string;     // OAuth only
  oauthTokenExpiresAt?: string;   // ISO 8601 string, OAuth only
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

// Shape of the API exposed by the preload bridge
export interface ElectronAPI {
  getTasks(): Promise<Task[]>;
  createTask(data: Partial<Task>): Promise<Task>;
  updateTask(id: string, updates: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;

  listAccounts(): Promise<AccountsState>;
  addAccount(data: {
    name?: string;
    authType: 'pat' | 'oauth';
    token?: string;
    oauthAccessToken?: string;
    oauthRefreshToken?: string;
    oauthTokenExpiresAt?: string;
    baseId: string;
    tableName: string;
  }): Promise<AccountsState>;
  updateAccount(id: string, updates: {
    name?: string;
    token?: string;
    oauthAccessToken?: string;
    oauthRefreshToken?: string;
    oauthTokenExpiresAt?: string;
    baseId?: string;
    tableName?: string;
  }): Promise<AccountsState>;
  deleteAccount(id: string): Promise<AccountsState>;
  switchAccount(id: string): Promise<AccountsState>;
  startOAuth(): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
  cancelOAuth(): Promise<void>;
  listBases(token: string): Promise<{ id: string; name: string }[]>;
  listTables(token: string, baseId: string): Promise<{ name: string }[]>;

  triggerSync(): Promise<void>;
  createTable(): Promise<void>;
  getSyncStatus(): Promise<SyncStatus>;

  onSyncStatus(cb: (status: SyncStatus) => void): () => void;
  onTasksUpdated(cb: (tasks: Task[]) => void): () => void;
  onAccountsUpdated(cb: (state: AccountsState) => void): () => void;

  openExternal(url: string): Promise<void>;
  openLink(url: string): Promise<void>;
  getTagOptions(): Promise<TagOption[]>;
  showError(title: string, detail: string): Promise<void>;
}
