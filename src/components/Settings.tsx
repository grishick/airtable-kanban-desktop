import { useEffect, useState } from 'react';
import type { Settings } from '../types';

interface Props {
  onSaved: () => void;
}

export default function SettingsPage({ onSaved }: Props) {
  const [token, setToken]             = useState('');
  const [baseId, setBaseId]           = useState('');
  const [tableName, setTableName]     = useState('Tasks');
  const [linkTarget, setLinkTarget]   = useState<'browser' | 'app'>('browser');
  const [pageSize, setPageSize]       = useState(10);
  const [saving, setSaving]           = useState(false);
  const [statusMsg, setStatusMsg]     = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    window.electronAPI.getSettings().then((s: Settings) => {
      setToken(s.airtable_access_token ?? '');
      setBaseId(s.airtable_base_id ?? '');
      setTableName(s.airtable_table_name ?? 'Tasks');
      setLinkTarget(s.link_open_target ?? 'browser');
      setPageSize(s.page_size ?? 10);
    }).catch(console.error);
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      await window.electronAPI.saveSettings({
        airtable_access_token: token.trim(),
        airtable_base_id: baseId.trim(),
        airtable_table_name: tableName.trim() || 'Tasks',
        link_open_target: linkTarget,
        page_size: pageSize,
      });
      setStatusMsg({ text: 'Settings saved. Sync will start automatically.', isError: false });
      setTimeout(() => onSaved(), 1000);
    } catch (err) {
      setStatusMsg({ text: String(err), isError: true });
    } finally {
      setSaving(false);
    }
  };

  const handleTestSync = async () => {
    setStatusMsg(null);
    try {
      await window.electronAPI.triggerSync();
      const s = await window.electronAPI.getSyncStatus();
      if (s.state === 'offline') {
        setStatusMsg({ text: 'Airtable is unreachable — working offline.', isError: true });
      } else if (s.state === 'error') {
        setStatusMsg({ text: `Sync error: ${s.error}`, isError: true });
      } else if (s.state === 'table_not_found') {
        setStatusMsg({ text: 'Connected! Table not found — go to Board and click "Create Tasks Table".', isError: false });
      } else {
        setStatusMsg({ text: 'Connection OK — sync completed.', isError: false });
      }
    } catch (err) {
      setStatusMsg({ text: String(err), isError: true });
    }
  };

  return (
    <div className="settings-container">
      <div className="settings-card">
        <h2>Airtable Settings</h2>
        <p>
          Connect to your Airtable base. Your credentials are stored locally and never leave your
          machine.
        </p>

        <form className="settings-form" onSubmit={handleSave}>
          <div className="form-group">
            <label htmlFor="at-token">Personal Access Token</label>
            <input
              id="at-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="patXXXXXXXXXXXXXX"
              autoComplete="off"
            />
          </div>

          <div className="form-group">
            <label htmlFor="at-base">Base ID</label>
            <input
              id="at-base"
              type="text"
              value={baseId}
              onChange={(e) => setBaseId(e.target.value)}
              placeholder="appXXXXXXXXXXXXXX"
            />
          </div>

          <div className="form-group">
            <label htmlFor="at-table">Table Name</label>
            <input
              id="at-table"
              type="text"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder="Tasks"
            />
          </div>

          <div className="form-group">
            <label htmlFor="link-target">Open links in</label>
            <select
              id="link-target"
              value={linkTarget}
              onChange={(e) => setLinkTarget(e.target.value as 'browser' | 'app')}
            >
              <option value="browser">Default browser</option>
              <option value="app">In-app window</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="page-size">Tasks per column (page size)</label>
            <input
              id="page-size"
              type="number"
              min={1}
              max={200}
              value={pageSize}
              onChange={(e) => setPageSize(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
          </div>

          <div className="settings-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestSync}
              disabled={saving || !token || !baseId}
            >
              Test &amp; Sync Now
            </button>
            {statusMsg && (
              <span className={`settings-status${statusMsg.isError ? ' error' : ''}`}>
                {statusMsg.text}
              </span>
            )}
          </div>
        </form>

        <div style={{ marginTop: 24, fontSize: 12, color: 'var(--text-muted)' }}>
          <strong>Where to find these values:</strong>
          <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>
              <strong>Personal Access Token</strong>: airtable.com → Account → Developer hub → Create a token.
              Required scopes: <code>data.records:read</code>, <code>data.records:write</code>,{' '}
              <code>schema.bases:read</code>, <code>schema.bases:write</code> (needed to auto-create the table).
            </li>
            <li>
              <strong>Base ID</strong>: Open your base, look at the URL:{' '}
              <code>airtable.com/appXXXXXXXX/…</code>
            </li>
            <li>
              <strong>Table Name</strong>: The exact name of your table tab (default: Tasks)
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
