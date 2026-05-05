// Tiny typed wrapper around `env.DB.prepare(...)`. Intentionally not an ORM —
// callers write SQL directly and pass a row type for the result shape.
//
// FK enforcement: D1 / SQLite require `PRAGMA foreign_keys = ON` per
// connection. Workers are short-lived but instances may be reused, so we set
// it lazily on first use per `D1Database` reference and avoid re-issuing it.

export type Row = Record<string, unknown>;

const fkInitialized = new WeakSet<D1Database>();

async function ensureForeignKeys(db: D1Database): Promise<void> {
  if (fkInitialized.has(db)) return;
  await db.prepare("PRAGMA foreign_keys = ON").run();
  fkInitialized.add(db);
}

function bind<T extends D1PreparedStatement>(stmt: T, params: readonly unknown[]): T {
  return params.length === 0 ? stmt : (stmt.bind(...params) as T);
}

/** Run a SELECT and return all rows typed as `T`. */
export async function queryAll<T extends Row>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  await ensureForeignKeys(db);
  const stmt = bind(db.prepare(sql), params);
  const result = await stmt.all<T>();
  return result.results ?? [];
}

/** Run a SELECT and return the first row, or `null` if none. */
export async function queryFirst<T extends Row>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  await ensureForeignKeys(db);
  const stmt = bind(db.prepare(sql), params);
  return (await stmt.first<T>()) ?? null;
}

export interface ExecMeta {
  changes: number;
  lastRowId: number | null;
}

/** Run an INSERT / UPDATE / DELETE; returns row counts. */
export async function execute(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<ExecMeta> {
  await ensureForeignKeys(db);
  const stmt = bind(db.prepare(sql), params);
  const result = await stmt.run();
  return {
    changes: result.meta?.changes ?? 0,
    lastRowId: result.meta?.last_row_id ?? null,
  };
}

/**
 * Run several prepared statements as a single D1 batch.
 *
 * Per Cloudflare D1: a `db.batch(...)` is an implicit SQL transaction —
 * statements run sequentially in one round-trip, and if any statement
 * fails the entire sequence is aborted and rolled back. This is the
 * atomicity primitive the platform exposes (it does not have interactive
 * transactions). Used by the user-deletion cascade (UNI-61) where the
 * issue spec requires "if any step fails, the whole delete rolls back".
 */
export async function batch(
  db: D1Database,
  statements: ReadonlyArray<{ sql: string; params?: readonly unknown[] }>,
): Promise<D1Result[]> {
  await ensureForeignKeys(db);
  const prepared = statements.map(({ sql, params = [] }) => bind(db.prepare(sql), params));
  return db.batch(prepared);
}
