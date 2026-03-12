import { useEffect, useRef, useState, useCallback } from 'react';
import type { Task, SyncStatus, TagOption } from './types';
import KanbanBoard from './components/KanbanBoard';
import Settings from './components/Settings';

type Page = 'board' | 'settings';

export default function App() {
  const [page, setPage] = useState<Page>('board');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [pageSize, setPageSize] = useState(10);
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

  // Load initial data
  useEffect(() => {
    window.electronAPI.getTasks().then(setTasks).catch(console.error);
    window.electronAPI.getSyncStatus().then(setSyncStatus).catch(console.error);
    window.electronAPI.getTagOptions().then(setTagOptions).catch(console.error);
    loadSettings();
  }, [loadSettings]);

  // Subscribe to push events from main process
  useEffect(() => {
    const unsub1 = window.electronAPI.onTasksUpdated((tasks) => {
      setTasks(tasks);
      // Re-fetch tag options after sync (sync may have updated them)
      window.electronAPI.getTagOptions().then(setTagOptions).catch(console.error);
    });
    const unsub2 = window.electronAPI.onSyncStatus(setSyncStatus);
    return () => { unsub1(); unsub2(); };
  }, []);

  // Show error dialog when sync fails (but not for transient offline state)
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

  const handleSettingsSaved = useCallback(() => {
    loadSettings();
    setPage('board');
  }, [loadSettings]);

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
