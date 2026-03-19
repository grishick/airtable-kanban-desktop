export interface TagOption {
  name: string;
  color: string | null;
}

interface MetaTable {
  id: string;
  name: string;
  fields: Array<{
    name: string;
    type: string;
    options?: { choices?: Array<{ name: string; color?: string }> };
  }>;
}

interface MetaTablesResponse {
  tables: MetaTable[];
}

export interface AirtableFields {
  'Task Name'?: string;
  Description?: string;
  Status?: string;
  Priority?: string;
  'Due Date'?: string;
  Tags?: string | string[];
  Position?: number;
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
}
