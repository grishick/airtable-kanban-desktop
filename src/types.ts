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
  airtable_access_token?: string;
  airtable_base_id?: string;
  airtable_table_name?: string;
  link_open_target?: 'browser' | 'app';
  page_size?: number;
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

  triggerSync(): Promise<void>;
  createTable(): Promise<void>;
  getSyncStatus(): Promise<SyncStatus>;

  onSyncStatus(cb: (status: SyncStatus) => void): () => void;
  onTasksUpdated(cb: (tasks: Task[]) => void): () => void;

  openExternal(url: string): Promise<void>;
  openLink(url: string): Promise<void>;
  getTagOptions(): Promise<TagOption[]>;
  showError(title: string, detail: string): Promise<void>;
}
