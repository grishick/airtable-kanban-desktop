import { useEffect, useState } from 'react';
import type { Account, Settings } from '../types';

interface Props {
  onSaved: () => void;
}

type EditMode = 'none' | 'add' | string; // string = account id being edited

export default function SettingsPage({ onSaved }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<EditMode>('none');

  const [formName, setFormName] = useState('');
  const [formToken, setFormToken] = useState('');
  const [formBaseId, setFormBaseId] = useState('');
  const [formTableName, setFormTableName] = useState('Tasks');

  const [linkTarget, setLinkTarget] = useState<'browser' | 'app'>('browser');
  const [pageSize, setPageSize] = useState(10);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    Promise.all([
      window.electronAPI.listAccounts(),
      window.electronAPI.getSettings(),
    ]).then(([{ accounts, activeId }, settings]) => {
      setAccounts(accounts);
      setActiveId(activeId);
      setLinkTarget((settings as Settings).link_open_target ?? 'browser');
      setPageSize((settings as Settings).page_size ?? 10);
    }).catch(console.error);
  }, []);

  const applyAccountsState = ({ accounts, activeId }: { accounts: Account[]; activeId: string | null }) => {
    setAccounts(accounts);
    setActiveId(activeId);
  };

  const startAdd = () => {
    setFormName('');
    setFormToken('');
    setFormBaseId('');
    setFormTableName('Tasks');
    setEditMode('add');
    setStatusMsg(null);
  };

  const startEdit = (account: Account) => {
    setFormName(account.name);
    setFormToken(account.token);
    setFormBaseId(account.baseId);
    setFormTableName(account.tableName);
    setEditMode(account.id);
    setStatusMsg(null);
  };

  const cancelEdit = () => {
    setEditMode('none');
    setStatusMsg(null);
  };

  const handleAccountFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      if (editMode === 'add') {
        const result = await window.electronAPI.addAccount({
          name: formName.trim() || undefined,
          token: formToken.trim(),
          baseId: formBaseId.trim(),
          tableName: formTableName.trim() || 'Tasks',
        });
        applyAccountsState(result);
        setStatusMsg({ text: 'Account added.', isError: false });
      } else if (editMode !== 'none') {
        const result = await window.electronAPI.updateAccount(editMode, {
          name: formName.trim() || undefined,
          token: formToken.trim(),
          baseId: formBaseId.trim(),
          tableName: formTableName.trim() || 'Tasks',
        });
        applyAccountsState(result);
        setStatusMsg({ text: 'Account updated.', isError: false });
      }
      setEditMode('none');
    } catch (err) {
      setStatusMsg({ text: String(err), isError: true });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const account = accounts.find((a) => a.id === id);
    if (!window.confirm(`Delete "${account?.name ?? 'this account'}"? All local task data for this account will be permanently deleted.`)) return;
    try {
      const result = await window.electronAPI.deleteAccount(id);
      applyAccountsState(result);
      if (editMode === id) setEditMode('none');
    } catch (err) {
      setStatusMsg({ text: String(err), isError: true });
    }
  };

  const handleSwitch = async (id: string) => {
    try {
      const result = await window.electronAPI.switchAccount(id);
      applyAccountsState(result);
    } catch (err) {
      setStatusMsg({ text: String(err), isError: true });
    }
  };

  const handleSaveAppSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      await window.electronAPI.saveSettings({ link_open_target: linkTarget, page_size: pageSize });
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
      } else if (s.state === 'unconfigured') {
        setStatusMsg({ text: 'No account configured.', isError: true });
      } else {
        setStatusMsg({ text: 'Connection OK — sync completed.', isError: false });
      }
    } catch (err) {
      setStatusMsg({ text: String(err), isError: true });
    }
  };

  const hasActiveAccount = accounts.some((a) => a.id === activeId);

  return (
    <div className="settings-container">
      <div className="settings-card">

        {/* ── Accounts ── */}
        <h2>Accounts</h2>

        {accounts.length === 0 && editMode !== 'add' && (
          <p>No accounts yet. Add one to connect to Airtable.</p>
        )}

        {accounts.length > 0 && (
          <div className="accounts-list">
            {accounts.map((account) => (
              <div
                key={account.id}
                className={`account-row${account.id === activeId ? ' account-row-active' : ''}`}
              >
                <div className="account-row-info">
                  <span className="account-row-name">{account.name}</span>
                  <span className="account-row-base">{account.baseId}</span>
                  {account.id === activeId && (
                    <span className="account-active-badge">Active</span>
                  )}
                </div>
                <div className="account-row-actions">
                  {account.id !== activeId && (
                    <button className="btn btn-sm btn-secondary" onClick={() => handleSwitch(account.id)}>
                      Use This
                    </button>
                  )}
                  <button className="btn btn-sm btn-secondary" onClick={() => startEdit(account)}>
                    Edit
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(account.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {editMode === 'none' && (
          <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={startAdd}>
            + Add Account
          </button>
        )}

        {/* Account add/edit form */}
        {editMode !== 'none' && (
          <form className="settings-form" style={{ marginTop: 16 }} onSubmit={handleAccountFormSubmit}>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
              {editMode === 'add' ? 'Add Account' : 'Edit Account'}
            </h3>

            <div className="form-group">
              <label>Account Name</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Auto-derived from base name if left empty"
              />
            </div>

            <div className="form-group">
              <label>Personal Access Token</label>
              <input
                type="password"
                value={formToken}
                onChange={(e) => setFormToken(e.target.value)}
                placeholder="patXXXXXXXXXXXXXX"
                autoComplete="off"
                required
              />
            </div>

            <div className="form-group">
              <label>Base ID</label>
              <input
                type="text"
                value={formBaseId}
                onChange={(e) => setFormBaseId(e.target.value)}
                placeholder="appXXXXXXXXXXXXXX"
                required
              />
            </div>

            <div className="form-group">
              <label>Table Name</label>
              <input
                type="text"
                value={formTableName}
                onChange={(e) => setFormTableName(e.target.value)}
                placeholder="Tasks"
              />
            </div>

            <div className="settings-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : (editMode === 'add' ? 'Add Account' : 'Save Account')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          </form>
        )}

        <hr className="settings-divider" />

        {/* ── App Settings ── */}
        <h2>App Settings</h2>
        <form className="settings-form" onSubmit={handleSaveAppSettings}>
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
              disabled={saving || !hasActiveAccount}
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
              <code>airtable.com/appXXXXXX/…</code>
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
