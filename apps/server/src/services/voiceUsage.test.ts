import { describe, expect, it } from 'vitest';
import { openAppDb } from '../storage/db.ts';
import { Repo } from '../storage/repo.ts';
import { VoiceUsageService, localDayKey } from './voiceUsage.ts';

describe('VoiceUsageService', () => {
  it('separates today from the rest of the month and leaves other months out of the totals', () => {
    const repo = new Repo(openAppDb(':memory:'));
    let now = new Date(2026, 8, 20, 18, 0, 0);
    const usage = new VoiceUsageService(repo, () => now);
    usage.record('openai-live', 600);
    now = new Date(2026, 7, 31, 12, 0, 0); // August
    usage.record('openai-live', 1_000);
    now = new Date(2026, 8, 21, 9, 0, 0);
    usage.record('openai-live', 120);
    usage.record('browser-tts', 45);

    expect(usage.summary()).toEqual({
      today: '2026-09-21',
      month: '2026-09',
      todaySeconds: 165,
      monthSeconds: 765,
      byProvider: { 'openai-live': { todaySeconds: 120, monthSeconds: 720 }, 'browser-tts': { todaySeconds: 45, monthSeconds: 45 } },
    });
    expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('caps a single report, ignores nonsense and survives a malformed stored value', () => {
    const repo = new Repo(openAppDb(':memory:'));
    const usage = new VoiceUsageService(repo, () => new Date(2026, 8, 21, 9, 0, 0));
    usage.record('openai-live', 1e9);
    usage.record('openai-live', Number.NaN);
    usage.record('openai-live', -5);
    expect(usage.summary().todaySeconds).toBe(21_600);

    repo.saveVoiceUsage({ days: { 'not-a-day': { 'openai-live': 5 }, '2026-09-21': { 'openai-live': 'many', hacker: 7, 'openai-realtime': 30 } } });
    expect(usage.summary()).toMatchObject({ todaySeconds: 30, byProvider: { 'openai-realtime': { todaySeconds: 30, monthSeconds: 30 } } });
    repo.saveVoiceUsage('garbage');
    expect(usage.summary().monthSeconds).toBe(0);
  });
});
