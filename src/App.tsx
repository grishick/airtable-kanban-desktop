import { useEffect, useRef, useState, useCallback } from 'react';
import type { Task, SyncStatus, TagOption, Account } from './types';
import KanbanBoard from './components/KanbanBoard';
import Settings from './components/Settings';

type Page = 'board' | 'settings';

export default function App() {
  const [page, setPage] = useState<Page>('board');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [pageSize, setPageSize] = useState(10);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    state: 'idle',
    lastSync: null,
    error: null,
    pendingOps: 0,
  });

  const loadSettings = useCallback(() => {
    window.electronAPI.getSettings()
      .then((s) => setPageSize(s.page_size ?? 10))
      .catch(console.error);
  }, []);

  const autoNavigateToSettings = useCallback((state: SyncStatus['state']) => {
    if (!autoNavigatedRef.current && (state === 'unconfigured' || state === 'table_not_found')) {
      autoNavigatedRef.current = true;
      setPage('settings');
    }
  }, []);

  // Load initial data
  useEffect(() => {
    window.electronAPI.getTasks().then(setTasks).catch(console.error);
    window.electronAPI.getSyncStatus().then((status) => {
      setSyncStatus(status);
      autoNavigateToSettings(status.state);
    }).catch(console.error);
    window.electronAPI.getTagOptions().then(setTagOptions).catch(console.error);
    loadSettings();
    window.electronAPI.listAccounts().then(({ accounts, activeId }) => {
      setAccounts(accounts);
      setActiveAccountId(activeId);
    }).catch(console.error);
  }, [loadSettings, autoNavigateToSettings]);

  // Subscribe to push events from main process
  useEffect(() => {
    const unsub1 = window.electronAPI.onTasksUpdated((tasks) => {
      setTasks(tasks);
      // Re-fetch tag options after sync (sync may have updated them)
      window.electronAPI.getTagOptions().then(setTagOptions).catch(console.error);
    });
    const unsub2 = window.electronAPI.onSyncStatus((status) => {
      setSyncStatus(status);
      autoNavigateToSettings(status.state);
    });
    const unsub3 = window.electronAPI.onAccountsUpdated(({ accounts, activeId }) => {
      setAccounts(accounts);
      setActiveAccountId(activeId);
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [autoNavigateToSettings]);

  // Show error dialog when sync fails (but not for transient offline state)
  const autoNavigatedRef = useRef(false);
  const lastShownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (syncStatus.state === 'error' && syncStatus.error) {
      const msg = syncStatus.error;
      if (msg !== lastShownErrorRef.current) {
        lastShownErrorRef.current = msg;
        window.electronAPI.showError('Sync Error', msg).catch(console.error);
      }
    } else if (syncStatus.state !== 'error') {
      // Reset so the same error can be shown again after a successful sync cycle
      lastShownErrorRef.current = null;
    }
  }, [syncStatus.state, syncStatus.error]);

  const handleCreateTask = useCallback(async (data: Partial<Task>) => {
    try {
      const task = await window.electronAPI.createTask(data);
      setTasks((prev) => [...prev, task]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.electronAPI.showError('Failed to Create Task', msg);
    }
  }, []);

  const handleUpdateTask = useCallback(async (id: string, updates: Partial<Task>) => {
    try {
      const task = await window.electronAPI.updateTask(id, updates);
      setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.electronAPI.showError('Failed to Update Task', msg);
    }
  }, []);

  const handleDeleteTask = useCallback(async (id: string) => {
    try {
      await window.electronAPI.deleteTask(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.electronAPI.showError('Failed to Delete Task', msg);
    }
  }, []);

  const handleSync = useCallback(async () => {
    await window.electronAPI.triggerSync();
  }, []);

  const handleSwitchAccount = useCallback(async (id: string) => {
    try {
      await window.electronAPI.switchAccount(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.electronAPI.showError('Failed to Switch Account', msg);
    }
  }, []);

  const handleSettingsSaved = useCallback(() => {
    loadSettings();
    setPage('board');
  }, [loadSettings]);

  const handleCreateTable = useCallback(async () => {
    try {
      await window.electronAPI.createTable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.electronAPI.showError('Failed to Create Table', msg);
    }
  }, []);

  const syncLabel = syncStatus.state === 'syncing'
    ? 'Syncing…'
    : syncStatus.lastSync
      ? `Synced ${formatRelative(syncStatus.lastSync)}`
      : syncStatus.state === 'unconfigured'
        ? 'Not configured'
        : 'Never synced';

  return (
    <div id="root" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <header className="app-header">
        <span className="app-title">Airtable Kanban</span>
        <button
          className={`nav-btn ${page === 'board' ? 'active' : ''}`}
          onClick={() => setPage('board')}
        >
          Board
        </button>
        <button
          className={`nav-btn ${page === 'settings' ? 'active' : ''}`}
          onClick={() => setPage('settings')}
        >
          Settings
        </button>
        {accounts.length > 1 && (
          <select
            className="account-switcher"
            value={activeAccountId ?? ''}
            onChange={(e) => handleSwitchAccount(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
        <span className="header-spacer" />
        <div className="sync-bar">
          <span className={`sync-indicator ${syncStatus.state}`} title={syncStatus.error ?? ''} />
          <span>{syncLabel}</span>
          {syncStatus.pendingOps > 0 && (
            <span title="Pending local changes">({syncStatus.pendingOps} pending)</span>
          )}
          <button
            className="sync-btn"
            onClick={handleSync}
            disabled={syncStatus.state === 'syncing' || syncStatus.state === 'unconfigured'}
          >
            Sync Now
          </button>
        </div>
      </header>

      {/* Unconfigured banner */}
      {syncStatus.state === 'unconfigured' && page === 'board' && (
        <div className="banner">
          ⚠ Airtable is not configured — showing local cache only.{' '}
          <button onClick={() => setPage('settings')}>Go to Settings</button>
        </div>
      )}

      {/* Table not found banner */}
      {syncStatus.state === 'table_not_found' && page === 'board' && (
        <div className="banner">
          ⚠ The configured Airtable table was not found.{' '}
          <button onClick={handleCreateTable}>Create Tasks Table</button>
        </div>
      )}

      {/* Page content */}
      {page === 'board' ? (
        <KanbanBoard
          tasks={tasks}
          tagOptions={tagOptions}
          pageSize={pageSize}
          onCreateTask={handleCreateTask}
          onUpdateTask={handleUpdateTask}
          onDeleteTask={handleDeleteTask}
        />
      ) : (
        <Settings onSaved={handleSettingsSaved} />
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
