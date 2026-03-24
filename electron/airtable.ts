export interface TagOption {
  name: string;
  color: string | null;
}

interface MetaTable {
  id: string;
  name: string;
  fields: Array<{
    id: string;
    name: string;
    type: string;
    options?: { choices?: Array<{ id?: string; name: string; color?: string }> };
  }>;
}

interface MetaTablesResponse {
  tables: MetaTable[];
}

export interface AirtableCollaborator {
  id: string;
  email?: string;
  name?: string;
}

export interface AirtableFields {
  'Task Name'?: string;
  Description?: string;
  Status?: string;
  Priority?: string;
  'Due Date'?: string;
  Tags?: string | string[];
  Position?: number;
  Assignee?: AirtableCollaborator | null;
  'Created By'?: AirtableCollaborator | null;
  [key: string]: unknown;
}

export interface AirtableRecord {
  id: string;
  fields: AirtableFields;
  createdTime: string;
}

interface ListResponse {
  records: AirtableRecord[];
  offset?: string;
}

export async function fetchBaseName(token: string, baseId: string): Promise<string | null> {
  try {
    const bases = await fetchBases(token);
    return bases.find(b => b.id === baseId)?.name ?? null;
  } catch {
    return null;
  }
}

export async function fetchBases(token: string): Promise<{ id: string; name: string }[]> {
  const resp = await fetch('https://api.airtable.com/v0/meta/bases', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`listBases failed: ${resp.status}`);
  const data = await resp.json() as { bases?: { id: string; name: string }[] };
  return data.bases ?? [];
}

export async function fetchTables(token: string, baseId: string): Promise<{ name: string }[]> {
  const resp = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`listTables failed: ${resp.status}`);
  const data = await resp.json() as { tables?: { name: string }[] };
  return (data.tables ?? []).map(t => ({ name: t.name }));
}

export class AirtableClient {
  private readonly baseUrl = 'https://api.airtable.com/v0';

  constructor(
    private token: string,
    private baseId: string,
    private tableName: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private get tableUrl(): string {
    return `${this.baseUrl}/${this.baseId}/${encodeURIComponent(this.tableName)}`;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.tableUrl}?maxRecords=1`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async fetchAllRecords(): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = [];
    let offset: string | undefined;

    do {
      const url = new URL(this.tableUrl);
      if (offset) url.searchParams.set('offset', offset);

      const resp = await fetch(url.toString(), {
        headers: this.headers,
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        throw new Error(`Airtable ${resp.status}: ${await resp.text()}`);
      }

      const data = (await resp.json()) as ListResponse;
      records.push(...data.records);
      offset = data.offset;
    } while (offset);

    return records;
  }

  async createRecord(fields: AirtableFields): Promise<AirtableRecord> {
    const resp = await fetch(this.tableUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      throw new Error(`Airtable ${resp.status}: ${await resp.text()}`);
    }
    return resp.json() as Promise<AirtableRecord>;
  }

  async updateRecord(recordId: string, fields: AirtableFields): Promise<AirtableRecord> {
    const resp = await fetch(`${this.tableUrl}/${recordId}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      throw new Error(`Airtable ${resp.status}: ${await resp.text()}`);
    }
    return resp.json() as Promise<AirtableRecord>;
  }

  async updateRecords(updates: { id: string; fields: AirtableFields }[]): Promise<void> {
    for (let i = 0; i < updates.length; i += 10) {
      const batch = updates.slice(i, i + 10);
      const resp = await fetch(this.tableUrl, {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({ records: batch }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) {
        throw new Error(`Airtable ${resp.status}: ${await resp.text()}`);
      }
    }
  }

  async deleteRecord(recordId: string): Promise<void> {
    const resp = await fetch(`${this.tableUrl}/${recordId}`, {
      method: 'DELETE',
      headers: this.headers,
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      throw new Error(`Airtable ${resp.status}: ${await resp.text()}`);
    }
  }

  async createTable(): Promise<void> {
    const url = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name: this.tableName,
        fields: [
          { name: 'Task Name', type: 'singleLineText' },
          {
            name: 'Status',
            type: 'singleSelect',
            options: {
              choices: [
                { name: 'Not Started' },
                { name: 'In Progress' },
                { name: 'Deferred' },
                { name: 'Waiting' },
                { name: 'Completed' },
              ],
            },
          },
          { name: 'Description', type: 'multilineText' },
          {
            name: 'Priority',
            type: 'singleSelect',
            options: { choices: [{ name: 'High' }, { name: 'Medium' }, { name: 'Low' }] },
          },
          { name: 'Due Date', type: 'date', options: { dateFormat: { name: 'iso', format: 'YYYY-MM-DD' } } },
          { name: 'Tags', type: 'multipleSelects', options: { choices: [] } },
          { name: 'Position', type: 'number', options: { precision: 1 } },
          { name: 'Assignee', type: 'singleCollaborator' },
          { name: 'Created By', type: 'createdBy' },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      if (resp.status === 403) {
        throw new Error(
          'Airtable 403: Cannot create table — your token is missing the "schema.bases:write" scope. ' +
          'Go to airtable.com → Account → Developer hub → edit your token and add that scope.',
        );
      }
      throw new Error(`Airtable ${resp.status}: ${await resp.text()}`);
    }
  }

  async ensurePositionField(): Promise<void> {
    const metaUrl = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
    const resp = await fetch(metaUrl, {
      headers: this.headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as MetaTablesResponse;
    const table = data.tables.find((t) => t.name === this.tableName);
    if (!table || table.fields.some((f) => f.name === 'Position')) return;

    await fetch(`${metaUrl}/${table.id}/fields`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name: 'Position', type: 'number', options: { precision: 1 } }),
      signal: AbortSignal.timeout(10000),
    });
  }

  async fetchTagOptions(tagsFieldName = 'Tags'): Promise<TagOption[]> {
    const metaUrl = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
    try {
      const resp = await fetch(metaUrl, {
        headers: this.headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as MetaTablesResponse;
      const table = data.tables.find((t) => t.name === this.tableName);
      if (!table) return [];
      const field = table.fields.find((f) => f.name === tagsFieldName);
      if (!field?.options?.choices) return [];
      return field.options.choices.map((c) => ({ name: c.name, color: c.color ?? null }));
    } catch {
      return [];
    }
  }

  async fetchStatusOptions(): Promise<Array<{ id?: string; name: string; color?: string }>> {
    const metaUrl = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
    try {
      const resp = await fetch(metaUrl, {
        headers: this.headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as MetaTablesResponse;
      const table = data.tables.find((t) => t.name === this.tableName);
      if (!table) return [];
      const field = table.fields.find((f) => f.name === 'Status');
      if (!field?.options?.choices) return [];
      return field.options.choices.map((c) => ({ id: c.id, name: c.name, color: c.color }));
    } catch {
      return [];
    }
  }

  async updateStatusFieldChoices(choices: Array<{ id?: string; name: string }>): Promise<void> {
    const metaUrl = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
    const resp = await fetch(metaUrl, {
      headers: this.headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Failed to fetch table metadata: ${resp.status}`);
    const data = (await resp.json()) as MetaTablesResponse;
    const table = data.tables.find((t) => t.name === this.tableName);
    if (!table) throw new Error('Table not found in Airtable');
    const field = table.fields.find((f) => f.name === 'Status');
    if (!field) throw new Error('Status field not found in Airtable table');

    const updateResp = await fetch(`${metaUrl}/${table.id}/fields/${field.id}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({
        options: {
          choices: choices.map((c) => c.id ? { id: c.id, name: c.name } : { name: c.name }),
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!updateResp.ok) {
      const text = await updateResp.text();
      if (updateResp.status === 403) {
        throw new Error(
          'Airtable 403: Cannot update Status field — your token is missing the ' +
          '"schema.bases:write" scope. Go to airtable.com → Account → Developer hub → ' +
          'edit your token and add that scope.',
        );
      }
      throw new Error(`Airtable ${updateResp.status}: ${text}`);
    }
  }

  async ensureAssigneeField(): Promise<void> {
    const metaUrl = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
    const resp = await fetch(metaUrl, {
      headers: this.headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as MetaTablesResponse;
    const table = data.tables.find((t) => t.name === this.tableName);
    if (!table || table.fields.some((f) => f.name === 'Assignee')) return;

    await fetch(`${metaUrl}/${table.id}/fields`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name: 'Assignee', type: 'singleCollaborator' }),
      signal: AbortSignal.timeout(10000),
    });
  }

  async ensureCreatedByField(): Promise<void> {
    const metaUrl = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
    const resp = await fetch(metaUrl, {
      headers: this.headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as MetaTablesResponse;
    const table = data.tables.find((t) => t.name === this.tableName);
    if (!table || table.fields.some((f) => f.name === 'Created By')) return;

    await fetch(`${metaUrl}/${table.id}/fields`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name: 'Created By', type: 'createdBy' }),
      signal: AbortSignal.timeout(10000),
    });
  }

  // ── Collaborators table operations ──────────────────────────────────

  private collabTableUrl(tableName: string): string {
    return `${this.baseUrl}/${this.baseId}/${encodeURIComponent(tableName)}`;
  }

  async fetchCollaboratorsTable(tableName: string): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = [];
    let offset: string | undefined;

    do {
      const url = new URL(this.collabTableUrl(tableName));
      if (offset) url.searchParams.set('offset', offset);

      const resp = await fetch(url.toString(), {
        headers: this.headers,
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        if (resp.status === 404 || text.includes('TABLE_NOT_FOUND') || text.includes('INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND')) {
          return [];
        }
        throw new Error(`Airtable ${resp.status}: ${text}`);
      }

      const data = (await resp.json()) as ListResponse;
      records.push(...data.records);
      offset = data.offset;
    } while (offset);

    return records;
  }

  async pushCollaboratorsToTable(
    tableName: string,
    collaborators: { userId: string; email: string | null; name: string | null }[],
  ): Promise<AirtableRecord[]> {
    const created: AirtableRecord[] = [];
    for (let i = 0; i < collaborators.length; i += 10) {
      const batch = collaborators.slice(i, i + 10).map((c) => ({
        fields: {
          'User ID': c.userId,
          Email: c.email ?? '',
          Name: c.name ?? '',
        },
      }));
      const resp = await fetch(this.collabTableUrl(tableName), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ records: batch }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) {
        throw new Error(`Airtable ${resp.status}: ${await resp.text()}`);
      }
      const data = (await resp.json()) as { records: AirtableRecord[] };
      created.push(...data.records);
    }
    return created;
  }

  async createCollaboratorsTable(tableName: string): Promise<void> {
    const url = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name: tableName,
        fields: [
          { name: 'User ID', type: 'singleLineText' },
          { name: 'Email', type: 'singleLineText' },
          { name: 'Name', type: 'singleLineText' },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (text.includes('DUPLICATE_TABLE_NAME')) return;
      throw new Error(`Airtable ${resp.status}: ${text}`);
    }
  }

  // ── Invite collaborator to base ─────────────────────────────────────

  async inviteCollaborator(email: string, permissionLevel: string): Promise<void> {
    const url = `https://api.airtable.com/v0/meta/bases/${this.baseId}/collaborators`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        collaborators: [
          { user: { email }, permissionLevel },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 422 || text.includes('INVALID_REQUEST_UNKNOWN')) {
        throw new Error(
          'Inviting collaborators via API requires an Airtable Enterprise plan. ' +
          'On other plans, use the share button in the Airtable web UI to invite collaborators.',
        );
      }
      throw new Error(`Airtable ${resp.status}: ${text}`);
    }
  }

  getBaseShareUrl(): string {
    return `https://airtable.com/${this.baseId}`;
  }
}
