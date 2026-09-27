import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, kvGet, kvGetJson, kvSet, kvSetJson, migrate, openAppDb, openDb } from './db.ts';

const dir = mkdtempSync(join(tmpdir(), 'gambit-db-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('db adapter', () => {
  it('creates the schema once and keeps data across reopen', () => {
    const path = join(dir, 'nested', 'app.sqlite');
    const db = openAppDb(path);
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(MIGRATIONS.length);
    const tables = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['game', 'kv', 'puzzle_attempt', 'review']));
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    kvSet(db, 'k', 'v1');
    kvSet(db, 'k', 'v2');
    db.close();
    db.close(); // idempotent

    const again = openAppDb(path);
    expect(kvGet(again, 'k')).toBe('v2');
    expect(migrate(again)).toBe(MIGRATIONS.length);
    again.close();
  });

  it('rolls a failed transaction back and supports nesting', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.tx(() => {
        kvSet(db, 'a', '1');
        db.tx(() => kvSet(db, 'b', '2'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(kvGet(db, 'a')).toBeUndefined();
    expect(kvGet(db, 'b')).toBeUndefined();
    expect(db.tx(() => 7)).toBe(7);
    db.close();
  });

  it('applies later migrations incrementally and refuses a newer database', () => {
    const db = openDb(':memory:');
    expect(migrate(db, ['CREATE TABLE a (x INTEGER)'])).toBe(1);
    expect(migrate(db, ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER)'])).toBe(2);
    db.run('INSERT INTO b (y) VALUES (?)', 5);
    expect(db.get<{ y: number }>('SELECT y FROM b')).toEqual({ y: 5 });
    expect(() => migrate(db, ['CREATE TABLE a (x INTEGER)'])).toThrow(/newer/);
    // a broken migration leaves the version untouched
    expect(() => migrate(db, ['x', 'y', 'THIS IS NOT SQL'])).toThrow();
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(2);
    db.close();
  });

  it('stores JSON values and survives corrupt ones', () => {
    const db = openDb(':memory:');
    migrate(db);
    kvSetJson(db, 'profile', { nickname: 'Миша', n: [1, 2] });
    expect(kvGetJson(db, 'profile')).toEqual({ nickname: 'Миша', n: [1, 2] });
    kvSet(db, 'broken', '{oops');
    expect(kvGetJson(db, 'broken')).toBeUndefined();
    expect(kvGetJson(db, 'missing')).toBeUndefined();
    db.close();
  });

  it('enforces the schema constraints', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => db.run(`INSERT INTO review (game_id, status, provider, markdown, updated_at) VALUES ('nope', 'pending', 'template', '', 'now')`)).toThrow(); // FK
    expect(() => db.run(`INSERT INTO kv (key, value) VALUES ('k', NULL)`)).toThrow();
    db.close();
  });
});
