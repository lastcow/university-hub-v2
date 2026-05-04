// Tiny in-memory D1 stand-in for unit tests. Intentionally minimal — we only
// implement the surface the mail service exercises: prepare/bind/run for
// INSERTs into email_logs (the FK PRAGMA call is a no-op).
//
// `executions` records every prepared statement run so tests can assert on the
// SQL and bound parameters. `forceRunError` lets a test simulate a write
// failure to confirm the writer swallows the error.

export interface PreparedExecution {
  sql: string;
  params: readonly unknown[];
}

export class FakeD1 {
  readonly executions: PreparedExecution[] = [];
  forceRunError: Error | null = null;

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this, sql, []);
  }

  // Real D1Database has many more methods (batch, exec, dump, etc.). The
  // mail service code only uses prepare(...).bind(...).run(), so that's all
  // we model here. Cast in tests via `as unknown as D1Database`.
}

export class FakePreparedStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly params: readonly unknown[],
  ) {}

  bind(...params: unknown[]): FakePreparedStatement {
    return new FakePreparedStatement(this.db, this.sql, params);
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number | null } }> {
    if (this.db.forceRunError) throw this.db.forceRunError;
    this.db.executions.push({ sql: this.sql, params: this.params });
    return { meta: { changes: 1, last_row_id: null } };
  }

  async first<T>(): Promise<T | null> {
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
}
