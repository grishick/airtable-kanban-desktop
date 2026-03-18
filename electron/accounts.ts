import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

export interface Account {
  id: string;
  name: string;
  token: string;
  baseId: string;
  tableName: string;
}

export interface AccountsFile {
  activeId: string | null;
  accounts: Account[];
}

function accountsFilePath(): string {
  return path.join(app.getPath('userData'), 'accounts.json');
}

export function loadAccountsFile(): AccountsFile {
  try {
    const raw = fs.readFileSync(accountsFilePath(), 'utf-8');
    return JSON.parse(raw) as AccountsFile;
  } catch {
    return { activeId: null, accounts: [] };
  }
}

export function saveAccountsFile(data: AccountsFile): void {
  fs.writeFileSync(accountsFilePath(), JSON.stringify(data, null, 2), 'utf-8');
}

export function getActiveAccount(): Account | null {
  const { activeId, accounts } = loadAccountsFile();
  if (!accounts.length) return null;
  return accounts.find((a) => a.id === activeId) ?? accounts[0];
}

export function dbPathForAccount(id: string): string {
  return path.join(app.getPath('userData'), `kanban-${id}.db`);
}

export function addAccount(data: Omit<Account, 'id'>): { account: Account; file: AccountsFile } {
  const file = loadAccountsFile();
  const account: Account = { ...data, id: randomUUID() };
  file.accounts.push(account);
  if (!file.activeId) file.activeId = account.id;
  saveAccountsFile(file);
  return { account, file };
}

export function updateAccount(
  id: string,
  updates: Partial<Omit<Account, 'id'>>,
): { account: Account; file: AccountsFile } | null {
  const file = loadAccountsFile();
  const idx = file.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  file.accounts[idx] = { ...file.accounts[idx], ...updates };
  saveAccountsFile(file);
  return { account: file.accounts[idx], file };
}

export function deleteAccount(id: string): AccountsFile {
  const file = loadAccountsFile();
  file.accounts = file.accounts.filter((a) => a.id !== id);
  if (file.activeId === id) {
    file.activeId = file.accounts[0]?.id ?? null;
  }
  saveAccountsFile(file);
  return file;
}

export function setActiveAccount(id: string): AccountsFile {
  const file = loadAccountsFile();
  if (file.accounts.some((a) => a.id === id)) {
    file.activeId = id;
    saveAccountsFile(file);
  }
  return file;
}
