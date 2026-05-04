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

export class ProgrammableD1 {
  readonly executions: RecordedExec[] = [];
  private firstResolvers: FirstResolver[] = [];
  private allResolvers: AllResolver[] = [];
  private writeHooks: WriteHook[] = [];

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
