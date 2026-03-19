import { useEffect, useState } from 'react';
import type { Account, Settings } from '../types';

const DEFAULT_OAUTH_LAMBDA_URL = 'https://airtable-kanban.widgeterian.com';
const normalizeLambdaUrl = (url: string) => url.trim().replace(/\/+$/, '');

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

  type AuthTab = 'pat' | 'oauth';
  const [addAuthTab, setAddAuthTab] = useState<AuthTab>('pat');
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthTokens, setOauthTokens] = useState<{
    accessToken: string; refreshToken: string; expiresAt: string;
  } | null>(null);
  const [oauthLambdaUrl, setOauthLambdaUrl] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [bases, setBases] = useState<{ id: string; name: string }[]>([]);
  const [basesLoading, setBasesLoading] = useState(false);
  const [basesError, setBasesError] = useState('');
  const [tables, setTables] = useState<{ name: string }[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState('');
  const [tableMode, setTableMode] = useState<'existing' | 'new'>('new');

  useEffect(() => {
    Promise.all([
      window.electronAPI.listAccounts(),
      window.electronAPI.getSettings(),
    ]).then(([{ accounts, activeId }, settings]) => {
      setAccounts(accounts);
      setActiveId(activeId);
      setLinkTarget((settings as Settings).link_open_target ?? 'browser');
      setPageSize((settings as Settings).page_size ?? 10);
      setOauthLambdaUrl(
        normalizeLambdaUrl((settings as Settings).oauth_lambda_url ?? DEFAULT_OAUTH_LAMBDA_URL),
      );
      setAppVersion((settings as Settings).app_version ?? '');
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
    setAddAuthTab('pat');
    setOauthPending(false);
    setOauthTokens(null);
    setBases([]);
    setBasesLoading(false);
    setBasesError('');
    setTables([]);
    setTablesLoading(false);
    setTablesError('');
    setTableMode('new');
  };

  const startEdit = (account: Account) => {
    setFormName(account.name);
    setFormToken(account.token ?? '');
    setFormBaseId(account.baseId);
    setFormTableName(account.tableName);
    setEditMode(account.id);
    setStatusMsg(null);
  };

  const cancelEdit = () => {
    const wasPending = oauthPending;
    setOauthPending(false);
    setOauthTokens(null);
    if (wasPending) {
      window.electronAPI.cancelOAuth().catch(() => {});
    }
    setEditMode('none');
    setStatusMsg(null);
  };

  const fetchTablesForBase = async (token: string, baseId: string) => {
    setTables([]);
    setTablesLoading(true);
    setTablesError('');
    try {
      const result = await window.electronAPI.listTables(token, baseId);
      setTables(result);
      setTableMode('existing');
      setFormTableName(result[0]?.name ?? 'Tasks');
    } catch {
      setTablesError('Could not load tables — enter name manually');
      setTableMode('new');
      setFormTableName('Tasks');
    } finally {
      setTablesLoading(false);
    }
  };

  const handleStartOAuth = async () => {
    setOauthPending(true);
    setStatusMsg(null);
    try {
      const tokens = await window.electronAPI.startOAuth();
      setOauthTokens(tokens);
      setBasesLoading(true);
      setBasesError('');
      try {
        const result = await window.electronAPI.listBases(tokens.accessToken);
        setBases(result);
        if (result.length > 0) {
          setFormBaseId(result[0].id);
          if (!formName.trim()) setFormName(result[0].name);
          await fetchTablesForBase(tokens.accessToken, result[0].id);
        }
      } catch {
        setBasesError('Could not load bases — enter ID manually');
      } finally {
        setBasesLoading(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly: Record<string, string> = {
        'Authorization was denied in the browser': 'Authorization was denied. Please try again.',
        'Session expired — please try again': 'Session expired. Please try again.',
        'Timed out waiting for Airtable authorization': 'Timed out. Please try again.',
        'Cancelled': '',
        'An OAuth flow is already in progress': 'Sign-in already in progress.',
        'OAuth Lambda URL is not configured in App Settings': 'Set the OAuth Lambda URL in App Settings first.',
      };
      const display = friendly[msg] ?? msg;
      if (display) setStatusMsg({ text: display, isError: true });
    } finally {
      setOauthPending(false);
    }
  };

  const handleReauthenticate = async () => {
    setOauthPending(true);
    setStatusMsg(null);
    try {
      const tokens = await window.electronAPI.startOAuth();
      if (editMode !== 'none' && editMode !== 'add') {
        const result = await window.electronAPI.updateAccount(editMode, {
          oauthAccessToken: tokens.accessToken,
          oauthRefreshToken: tokens.refreshToken,
          oauthTokenExpiresAt: tokens.expiresAt,
        });
        applyAccountsState(result);
        setStatusMsg({ text: 'Re-authenticated successfully.', isError: false });
        setTimeout(() => setEditMode('none'), 1500);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'Cancelled') setStatusMsg({ text: msg, isError: true });
    } finally {
      setOauthPending(false);
    }
  };

  const handleAccountFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      if (editMode === 'add') {
        if (addAuthTab === 'oauth') {
          if (!oauthTokens) {
            setStatusMsg({ text: 'Complete sign-in with Airtable first.', isError: true });
            setSaving(false);
            return;
          }
          const result = await window.electronAPI.addAccount({
            authType: 'oauth',
            name: formName.trim() || undefined,
            oauthAccessToken: oauthTokens.accessToken,
            oauthRefreshToken: oauthTokens.refreshToken,
            oauthTokenExpiresAt: oauthTokens.expiresAt,
            baseId: formBaseId.trim(),
            tableName: formTableName.trim() || 'Tasks',
          });
          applyAccountsState(result);
          setStatusMsg({ text: 'Account added.', isError: false });
        } else {
          const result = await window.electronAPI.addAccount({
            authType: 'pat',
            name: formName.trim() || undefined,
            token: formToken.trim(),
            baseId: formBaseId.trim(),
            tableName: formTableName.trim() || 'Tasks',
          });
          applyAccountsState(result);
          setStatusMsg({ text: 'Account added.', isError: false });
        }
        setEditMode('none');
      } else if (editMode !== 'none') {
        const isOAuth = accounts.find(a => a.id === editMode)?.authType === 'oauth';
        const result = await window.electronAPI.updateAccount(editMode, {
          name: formName.trim() || undefined,
          ...(isOAuth ? {} : { token: formToken.trim() }),
          baseId: formBaseId.trim(),
          tableName: formTableName.trim() || 'Tasks',
        });
        applyAccountsState(result);
        setStatusMsg({ text: 'Account updated.', isError: false });
        setEditMode('none');
      }
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
      const cleanedOauthLambdaUrl = normalizeLambdaUrl(oauthLambdaUrl);
      await window.electronAPI.saveSettings({
        link_open_target: linkTarget,
        page_size: pageSize,
        oauth_lambda_url: cleanedOauthLambdaUrl || DEFAULT_OAUTH_LAMBDA_URL,
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
          <div className="onboarding-block">
            <p className="onboarding-heading">Connect to Airtable to get started</p>
            <div className="onboarding-options">
              <div className="onboarding-option">
                <span className="onboarding-option-label">Already have an account?</span>
                <button className="btn btn-primary" onClick={startAdd}>
                  Add Account
                </button>
              </div>
              <div className="onboarding-divider">or</div>
              <div className="onboarding-option">
                <span className="onboarding-option-label">New to Airtable?</span>
                <button
                  className="btn btn-secondary"
                  onClick={() => window.electronAPI.openExternal('https://airtable.com/invite/r/V373PiX4')}
                >
                  Sign up for free
                </button>
                <span className="onboarding-hint">
                  After signing up, come back here and click Add Account.
                </span>
              </div>
            </div>
          </div>
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

        {editMode === 'none' && accounts.length > 0 && (
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

            {/* Auth type toggle — only when adding */}
            {editMode === 'add' && (
              <div className="auth-tab-toggle">
                <button
                  type="button"
                  className={`auth-tab-btn${addAuthTab === 'pat' ? ' active' : ''}`}
                  onClick={() => { setAddAuthTab('pat'); setOauthTokens(null); }}
                >
                  Personal Access Token
                </button>
                <button
                  type="button"
                  className={`auth-tab-btn${addAuthTab === 'oauth' ? ' active' : ''}`}
                  onClick={() => { setAddAuthTab('oauth'); setOauthTokens(null); }}
                >
                  Sign in with Airtable
                </button>
              </div>
            )}

            <div className="form-group">
              <label>Account Name</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Auto-derived from base name if left empty"
              />
            </div>

            {/* PAT token field — shown for PAT tab (add) or PAT accounts (edit) */}
            {(addAuthTab === 'pat' && editMode === 'add') ||
             (editMode !== 'add' && accounts.find(a => a.id === editMode)?.authType !== 'oauth') ? (
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
            ) : null}

            {/* OAuth sign-in area — only when adding via OAuth tab */}
            {addAuthTab === 'oauth' && editMode === 'add' && !oauthTokens && (
              <div className="form-group">
                {!oauthPending ? (
                  <button type="button" className="btn btn-primary" onClick={handleStartOAuth}>
                    Sign in with Airtable
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>Waiting for browser…</span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => { window.electronAPI.cancelOAuth().catch(() => {}); }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* OAuth success: base picker (or fallback text input) */}
            {oauthTokens && editMode === 'add' && (
              <>
                <p style={{ fontSize: 13, color: 'green', margin: '4px 0' }}>✓ Signed in</p>
                <div className="form-group">
                  <label>Base</label>
                  {basesError ? (
                    <>
                      <input
                        type="text"
                        value={formBaseId}
                        onChange={(e) => setFormBaseId(e.target.value)}
                        placeholder="appXXXXXXXXXXXXXX"
                        required
                      />
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{basesError}</span>
                    </>
                  ) : (
                    <select
                      value={formBaseId}
                      onChange={(e) => {
                        setFormBaseId(e.target.value);
                        const selectedBase = bases.find(b => b.id === e.target.value);
                        if (selectedBase) setFormName(selectedBase.name);
                        fetchTablesForBase(oauthTokens.accessToken, e.target.value);
                      }}
                      disabled={basesLoading}
                      required
                    >
                      {basesLoading
                        ? <option value="">Loading bases…</option>
                        : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)
                      }
                    </select>
                  )}
                </div>

                <div className="form-group">
                  <label>Table</label>
                  <select
                    value={tableMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'existing' | 'new';
                      setTableMode(mode);
                      if (mode === 'new') {
                        setFormTableName('Tasks');
                      } else {
                        setFormTableName(tables[0]?.name ?? 'Tasks');
                      }
                    }}
                    disabled={tablesLoading}
                  >
                    <option value="existing">Use existing table</option>
                    <option value="new">Create new table</option>
                  </select>

                  {!tablesLoading && tableMode === 'existing' && tables.length > 0 && (
                    <select
                      value={formTableName}
                      onChange={(e) => setFormTableName(e.target.value)}
                      style={{ marginTop: 6 }}
                    >
                      {tables.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                    </select>
                  )}

                  {!tablesLoading && tableMode === 'new' && (
                    <input
                      type="text"
                      value={formTableName}
                      onChange={(e) => setFormTableName(e.target.value)}
                      placeholder="Tasks"
                      style={{ marginTop: 6 }}
                    />
                  )}

                  {tablesError && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
                      {tablesError}
                    </span>
                  )}
                </div>
              </>
            )}

            {/* Re-authenticate button for editing OAuth accounts */}
            {editMode !== 'add' && accounts.find(a => a.id === editMode)?.authType === 'oauth' && (
              <div className="form-group">
                {!oauthPending ? (
                  <button type="button" className="btn btn-secondary" onClick={handleReauthenticate}>
                    Re-authenticate
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>Waiting for browser…</span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => { window.electronAPI.cancelOAuth().catch(() => {}); }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* PAT tab or editing: plain text inputs */}
            {(addAuthTab === 'pat' || editMode !== 'add') && (
              <>
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
              </>
            )}

            <div className="settings-actions">
              <button type="submit" className="btn btn-primary" disabled={saving || oauthPending || basesLoading || tablesLoading}>
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
            <label htmlFor="oauth-lambda-url">OAuth Lambda URL</label>
            <input
              id="oauth-lambda-url"
              type="url"
              value={oauthLambdaUrl}
              onChange={(e) => setOauthLambdaUrl(e.target.value)}
                  placeholder={DEFAULT_OAUTH_LAMBDA_URL}
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

        {!(addAuthTab === 'oauth' && oauthTokens && editMode === 'add') && (
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
        )}

        {appVersion && (
          <p style={{ marginTop: 24, fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}>
            v{appVersion}
          </p>
        )}

      </div>
    </div>
  );
}
