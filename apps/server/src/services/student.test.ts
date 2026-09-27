import { describe, expect, it } from 'vitest';
import { fallbackCurriculum } from '../content.ts';
import { kvGetJson, kvSetJson, migrate, openDb } from '../storage/db.ts';
import { Repo } from '../storage/repo.ts';
import { StudentService } from './student.ts';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const repo = new Repo(db);
  return { db, repo, student: new StudentService(repo, { curriculum: fallbackCurriculum() }) };
}

describe('StudentService', () => {
  it('creates the default profile once', () => {
    const { student, repo } = setup();
    const first = student.getProfile();
    expect(first).toMatchObject({ nickname: 'Шахматист', address: 'm', stage: 1, bestWin: null });
    expect(repo.loadProfile()).toEqual(first);
    expect(student.getProfile().updatedAt).toBe(first.updatedAt);
  });

  it('repairs a profile that no longer validates instead of wiping it, and keeps a backup', () => {
    const { student, db } = setup();
    const good = student.getProfile();
    const damaged = { ...good, nickname: 'Миша', stage: 4, totals: { ...good.totals, games: 12 }, address: 'robot', recentAccuracy: 'oops' };
    kvSetJson(db, 'student-profile', damaged);

    const repaired = student.getProfile();
    expect(repaired.nickname).toBe('Миша');
    expect(repaired.stage).toBe(4);
    expect(repaired.totals.games).toBe(12);
    expect(repaired.address).toBe('m');
    expect(repaired.recentAccuracy).toEqual([]);

    const backups = db.all<{ key: string }>(`SELECT key FROM kv WHERE key LIKE 'student-profile.backup.%'`);
    expect(backups).toHaveLength(1);
    expect(kvGetJson(db, backups[0]?.key ?? '')).toEqual(damaged);
    // repaired once, stable afterwards
    student.getProfile();
    expect(db.all(`SELECT key FROM kv WHERE key LIKE 'student-profile.backup.%'`)).toHaveLength(1);
  });

  it('resets the stage clock on a manual stage change only', () => {
    const { student, repo } = setup();
    const profile = student.getProfile();
    repo.saveProfile({ ...profile, totals: { ...profile.totals, games: 7 } });
    student.update({ nickname: 'Лев' });
    expect(repo.loadStageMeta()).toEqual({ gamesAtStageStart: 0 });
    const changed = student.update({ stage: 3 });
    expect(changed.stage).toBe(3);
    // (and when: a game marked «играл взрослый» later recounts the games before the stage from this moment)
    expect(repo.loadStageMeta()).toEqual({ gamesAtStageStart: 7, stageStartedAt: changed.updatedAt });
    // a parent may also move the child down — only the automatic suggestion never demotes
    expect(student.update({ stage: 2 }).stage).toBe(2);
    expect(student.update({ stage: 99 }).stage).toBe(10);
  });
});
