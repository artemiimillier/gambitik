import { describe, expect, it } from 'vitest';
import { PARENT_GATE_STORAGE_KEY, PARENT_GATE_VALID_MS, checkGateAnswer, isGateOpen, makeGateQuestion, openGate } from './parentGate.ts';
import { createMemoryStorage } from './testUtils.ts';

describe('parent gate', () => {
  it('asks a two-digit sum that always carries — real work for a second-grader', () => {
    for (const r of [0, 0.13, 0.5, 0.77, 0.999, 1, -1, Number.NaN]) {
      let calls = 0;
      const question = makeGateQuestion(() => (Number.isNaN(r) ? 0 : (r + calls++ * 0.31) % 1));
      expect(question.a).toBeGreaterThanOrEqual(25);
      expect(question.b).toBeGreaterThanOrEqual(25);
      expect(question.a).toBeLessThan(100);
      expect(question.b).toBeLessThan(100);
      expect((question.a % 10) + (question.b % 10)).toBeGreaterThanOrEqual(11);
      expect(question.answer).toBe(question.a + question.b);
      expect(question.text).toBe(`${question.a} + ${question.b}`);
    }
  });

  it('accepts only the right number', () => {
    const question = { answer: 85 };
    expect(checkGateAnswer(question, '85')).toBe(true);
    expect(checkGateAnswer(question, ' 85 ')).toBe(true);
    for (const wrong of ['', '84', '85.0', '8 5', 'восемьдесят пять', '085x', '-85', '99999999']) expect(checkGateAnswer(question, wrong), wrong).toBe(false);
  });

  it('stays open for ten minutes of the tab, then asks again', () => {
    const storage = createMemoryStorage();
    const now = 1_000_000;
    expect(isGateOpen(storage, now)).toBe(false);
    openGate(storage, now);
    expect(isGateOpen(storage, now + 1)).toBe(true);
    expect(isGateOpen(storage, now + PARENT_GATE_VALID_MS - 1)).toBe(true);
    expect(isGateOpen(storage, now + PARENT_GATE_VALID_MS)).toBe(false);
  });

  it('a hand-written far-future or junk value does not keep the gate open', () => {
    const now = 1_000_000;
    expect(isGateOpen(createMemoryStorage({ [PARENT_GATE_STORAGE_KEY]: String(now + 365 * 24 * 3600_000) }), now)).toBe(false);
    expect(isGateOpen(createMemoryStorage({ [PARENT_GATE_STORAGE_KEY]: 'open sesame' }), now)).toBe(false);
    expect(isGateOpen(null, now)).toBe(false);
    expect(() => openGate(null, now)).not.toThrow();
  });
});
