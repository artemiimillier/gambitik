/**
 * Thin adapter over the built-in `node:sqlite` (`DatabaseSync`, release candidate in Node 26).
 * Everything else talks to this interface, so swapping in better-sqlite3 later is a one-file job.
 */
import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T extends object = SqlRow>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T extends object = SqlRow>(sql: string, ...params: SqlValue[]): T[];
  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT; rolls back and rethrows on error. Re-entrant. */
  tx<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDbOptions {
  readOnly?: boolean;
  /** skip WAL / pragmas that need write access */
  skipPragmas?: boolean;
  /**
   * How long a statement waits for a lock held by another process (default 3000 ms). node:sqlite is
   * synchronous: while it waits, the WHOLE server is blocked — read-only side databases use ≤ 200 ms.
   */
  busyTimeoutMs?: number;
}

/** Child data is private to the account that runs the trainer. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function chmodQuietly(path: string, mode: number): void {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch {
    // not the owner / exotic file system: the data directory mode (0700) still protects the file
  }
}

class SqliteDb implements Db {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;
  private closed = false;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T extends object = SqlRow>(sql: string, ...params: SqlValue[]): T | undefined {
    const row = this.prepare(sql).get(...params);
    return row === undefined ? undefined : ({ ...row } as T);
  }

  all<T extends object = SqlRow>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }) as T);
  }

  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // the original error matters more
      }
      throw error;
    } finally {
      this.txDepth = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}

/** Opens (and creates when missing) a SQLite database file. `:memory:` is supported. */
export function openDb(path: string, options: OpenDbOptions = {}): Db {
  const readOnly = options.readOnly === true;
  const onDisk = path !== ':memory:';
  if (!readOnly && onDisk) mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  const raw = new DatabaseSync(path, { readOnly, timeout: options.busyTimeoutMs ?? 3000, enableForeignKeyConstraints: true });
  try {
    if (!readOnly && onDisk) {
      // SQLite creates -wal / -shm with the mode of the main file, so the main file goes first
      chmodQuietly(path, PRIVATE_FILE_MODE);
      chmodQuietly(`${path}-wal`, PRIVATE_FILE_MODE);
      chmodQuietly(`${path}-shm`, PRIVATE_FILE_MODE);
    }
    if (!readOnly && options.skipPragmas !== true) {
      raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
  } catch (error) {
    raw.close();
    throw error;
  }
  return new SqliteDb(raw);
}

// ───────────────────────── migrations ─────────────────────────

/**
 * Hand-written migrations; the applied version lives in `PRAGMA user_version`.
 * Never edit a released migration — append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE game (
    id              TEXT PRIMARY KEY,
    started_at      TEXT NOT NULL,
    ended_at        TEXT NOT NULL,
    persona_id      TEXT NOT NULL,
    time_control_id TEXT NOT NULL,
    child_color     TEXT NOT NULL CHECK (child_color IN ('w','b')),
    result          TEXT NOT NULL,
    termination     TEXT NOT NULL,
    accuracy        REAL NOT NULL,
    blunders        INTEGER NOT NULL,
    exam_mode       INTEGER NOT NULL CHECK (exam_mode IN (0,1)),
    record_json     TEXT NOT NULL CHECK (json_valid(record_json)),
    file_base       TEXT,
    created_at      TEXT NOT NULL
  ) STRICT;
  CREATE INDEX game_started_at ON game (started_at DESC);

  CREATE TABLE review (
    game_id         TEXT PRIMARY KEY REFERENCES game (id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('pending','ready','template','failed')),
    provider        TEXT NOT NULL CHECK (provider IN ('codex','openai-api','template')),
    markdown        TEXT NOT NULL,
    takeaways_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(takeaways_json)),
    suggested_theme TEXT,
    updated_at      TEXT NOT NULL
  ) STRICT;

  CREATE TABLE puzzle_attempt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_id     TEXT NOT NULL,
    solved        INTEGER NOT NULL CHECK (solved IN (0,1)),
    ms_spent      INTEGER NOT NULL,
    hints_used    INTEGER NOT NULL,
    themes        TEXT NOT NULL,
    puzzle_rating INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  ) STRICT;
  CREATE INDEX puzzle_attempt_puzzle ON puzzle_attempt (puzzle_id);

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  `,
  // 2: reviews may come from OpenRouter (GameReview.provider 'openrouter'); SQLite cannot alter a CHECK, so the table is rebuilt
  `
  CREATE TABLE review_v2 (
    game_id         TEXT PRIMARY KEY REFERENCES game (id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('pending','ready','template','failed')),
    provider        TEXT NOT NULL CHECK (provider IN ('codex','openrouter','openai-api','template')),
    markdown        TEXT NOT NULL,
    takeaways_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(takeaways_json)),
    suggested_theme TEXT,
    updated_at      TEXT NOT NULL
  ) STRICT;
  INSERT INTO review_v2 (game_id, status, provider, markdown, takeaways_json, suggested_theme, updated_at)
    SELECT game_id, status, provider, markdown, takeaways_json, suggested_theme, updated_at FROM review;
  DROP TABLE review;
  ALTER TABLE review_v2 RENAME TO review;
  `,
  // 3: a game can be left out of the child's progress (played by an adult / archived by «Начать прогресс заново»),
  //    and the child's thoughts that arrive after the record was saved are appended per game (idempotent by item id)
  `
  ALTER TABLE game ADD COLUMN excluded TEXT CHECK (excluded IN ('adult','archived'));
  CREATE TABLE game_thought (
    game_id    TEXT NOT NULL REFERENCES game (id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('voice','typed')),
    question   TEXT,
    text       TEXT NOT NULL,
    said_at    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (game_id, item_id)
  ) STRICT;
  `,
];

export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  let version = Number(row?.user_version ?? 0);
  if (version > migrations.length) {
    throw new Error(`Database schema version ${version} is newer than this server (${migrations.length}).`);
  }
  while (version < migrations.length) {
    const sql = migrations[version];
    if (sql === undefined) break;
    const next = version + 1;
    db.tx(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }
  return version;
}

/** SQLITE_CORRUPT (11) / SQLITE_NOTADB (26): the file itself is damaged — as opposed to busy, read-only, too new, … */
export function isCorruptDbError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = 'errcode' in error && typeof error.errcode === 'number' ? error.errcode & 0xff : null;
  if (errcode === 11 || errcode === 26) return true;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return /file is not a database|database disk image is malformed|malformed database schema/i.test(message);
}

export class CorruptDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptDatabaseError';
  }
}

function openChecked(path: string): Db {
  const db = openDb(path);
  try {
    // cheap structural check (app.sqlite is small); anything but a single 'ok' row means damage
    const rows = db.all<{ quick_check: string }>('PRAGMA quick_check');
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') throw new CorruptDatabaseError('PRAGMA quick_check reported damage');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface OpenAppDbOptions {
  log?: (message: string) => void;
  now?: () => Date;
}

/**
 * Opens data/app.sqlite and brings it to the latest schema.
 *
 * A damaged file must not keep the child from playing: it is moved aside as
 * `app.sqlite.corrupt-<timestamp>` (with its -wal / -shm), a clear message is logged, and the
 * server starts on a fresh database. Nothing is deleted — the per-game PGN / journal files and the
 * quarantined database stay available for manual recovery. Other failures (locked, newer schema,
 * permissions) are NOT treated as corruption and still stop the start-up.
 */
export function openAppDb(path: string, options: OpenAppDbOptions = {}): Db {
  try {
    return openChecked(path);
  } catch (error) {
    if (path === ':memory:' || !(error instanceof CorruptDatabaseError || isCorruptDbError(error))) throw error;
    const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${path}.corrupt-${stamp}`;
    renameSync(path, quarantine);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${quarantine}${suffix}`);
    }
    const log = options.log ?? ((message: string) => console.error(message));
    log(`[db] ВНИМАНИЕ: файл базы данных повреждён и отложен в сторону: ${quarantine}`);
    log('[db] Гамбитик запускается с чистой базой: профиль и список партий начнутся заново. Файлы партий (data/games) и отложенная база сохранены — их можно восстановить вручную.');
    return openChecked(path);
  }
}

// ───────────────────────── kv helpers ─────────────────────────

export function kvGet(db: Db, key: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
}

export function kvGetJson(db: Db, key: string): unknown {
  const raw = kvGet(db, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function kvSetJson(db: Db, key: string, value: unknown): void {
  kvSet(db, key, JSON.stringify(value));
}
