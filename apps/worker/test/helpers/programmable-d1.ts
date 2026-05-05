// More capable in-memory D1 stand-in for route tests.
//
// Tests register `first` / `all` resolvers that are matched against the SQL
// string and bound params; INSERT/UPDATE/DELETE statements pass through to
// `executions` so tests can assert on writes (especially the audit_logs and
// email_logs rows). The resolvers receive a normalized SQL (whitespace
// collapsed) so callers can match against substrings safely.

export interface RecordedExec {
  sql: string;
  normalizedSql: string;
  params: readonly unknown[];
}

type FirstResolver<T = unknown> = (sql: string, params: readonly unknown[]) => T | null | undefined;
type AllResolver<T = unknown> = (sql: string, params: readonly unknown[]) => T[] | null | undefined;

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export type WriteHook = (sql: string, params: readonly unknown[]) => void;

/**
 * `batch(...)` resolver. By default `db.batch` runs each statement through
 * `recordRun` exactly like a sequential `execute()` would, so write-hooks
 * fire and `executions` records the SQL. Tests that want to simulate a
 * mid-cascade rollback register a `batch` failure via `failBatchOnce` —
 * the next batch call throws and **none** of its statements are recorded
 * (matching the "the whole delete rolls back" guarantee from the issue).
 */

export class ProgrammableD1 {
  readonly executions: RecordedExec[] = [];
  readonly batches: RecordedExec[][] = [];
  private firstResolvers: FirstResolver[] = [];
  private allResolvers: AllResolver[] = [];
  private writeHooks: WriteHook[] = [];
  private nextBatchFailure: Error | null = null;

  /**
   * Register a `first()` resolver. The first resolver to return a non-undefined
   * value wins; `null` explicitly means "no row".
   */
  onFirst<T>(resolver: FirstResolver<T>): void {
    this.firstResolvers.push(resolver as FirstResolver);
  }

  onAll<T>(resolver: AllResolver<T>): void {
    this.allResolvers.push(resolver as AllResolver);
  }

  /** Hook fired after every INSERT/UPDATE/DELETE so seeded fixtures can update. */
  onWrite(hook: WriteHook): void {
    this.writeHooks.push(hook);
  }

  prepare(sql: string): ProgrammableStatement {
    return new ProgrammableStatement(this, sql, []);
  }

  /**
   * Mock `env.DB.batch(...)`. Real D1 runs the supplied prepared statements
   * inside a SQL transaction and rolls everything back on any failure;
   * we mirror that semantic by either:
   *   (a) running each statement through `recordRun` so write-hooks fire
   *       and the SQL appears in `executions` AND the batch in `batches`,
   *       or
   *   (b) if a failure was queued via `failBatchOnce()`, throwing without
   *       recording anything — leaving the in-memory fixtures untouched.
   */
  async batch(prepared: ReadonlyArray<ProgrammableStatement>): Promise<unknown[]> {
    if (this.nextBatchFailure) {
      const err = this.nextBatchFailure;
      this.nextBatchFailure = null;
      throw err;
    }
    const recorded: RecordedExec[] = [];
    for (const stmt of prepared) {
      const sql = stmt.getSql();
      const params = stmt.getParams();
      const normalized = normalize(sql);
      const exec: RecordedExec = { sql, normalizedSql: normalized, params };
      this.executions.push(exec);
      recorded.push(exec);
      for (const hook of this.writeHooks) hook(normalized, params);
    }
    this.batches.push(recorded);
    return prepared.map(() => ({ meta: { changes: 1, last_row_id: null } }));
  }

  /**
   * Queue a failure for the *next* `batch(...)` call. The failure throws
   * before any statement is recorded so tests can assert that no writes
   * landed (which is what "the cascade rolls back" looks like from the
   * caller's vantage point). Call once per failure scenario.
   */
  failBatchOnce(message = "simulated batch failure"): void {
    this.nextBatchFailure = new Error(message);
  }

  // Internal: invoked by ProgrammableStatement.
  resolveFirst(sql: string, params: readonly unknown[]): unknown {
    const normalized = normalize(sql);
    for (const r of this.firstResolvers) {
      const out = r(normalized, params);
      if (out !== undefined) return out;
    }
    return null;
  }

  resolveAll(sql: string, params: readonly unknown[]): unknown[] {
    const normalized = normalize(sql);
    for (const r of this.allResolvers) {
      const out = r(normalized, params);
      if (out !== undefined) return out ?? [];
    }
    return [];
  }

  recordRun(sql: string, params: readonly unknown[]): void {
    const normalized = normalize(sql);
    this.executions.push({ sql, normalizedSql: normalized, params });
    for (const hook of this.writeHooks) hook(normalized, params);
  }

  /** Convenience: all `INSERT INTO <table>` rows recorded so far. */
  inserts(table: string): RecordedExec[] {
    const needle = `INSERT INTO ${table}`.toLowerCase();
    return this.executions.filter((e) => e.normalizedSql.toLowerCase().startsWith(needle));
  }

  updates(table: string): RecordedExec[] {
    const needle = `UPDATE ${table}`.toLowerCase();
    return this.executions.filter((e) => e.normalizedSql.toLowerCase().startsWith(needle));
  }
}

export class ProgrammableStatement {
  constructor(
    private readonly db: ProgrammableD1,
    private readonly sql: string,
    private readonly params: readonly unknown[],
  ) {}

  bind(...params: unknown[]): ProgrammableStatement {
    return new ProgrammableStatement(this.db, this.sql, params);
  }

  // Internal accessors so `ProgrammableD1.batch(...)` can introspect a
  // prepared statement without exposing the constructor parameters.
  getSql(): string {
    return this.sql;
  }
  getParams(): readonly unknown[] {
    return this.params;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.resolveFirst(this.sql, this.params) as T | null) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.resolveAll(this.sql, this.params) as T[] };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number | null } }> {
    this.db.recordRun(this.sql, this.params);
    return { meta: { changes: 1, last_row_id: null } };
  }
}
