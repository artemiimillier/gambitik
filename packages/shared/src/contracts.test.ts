import { describe, expect, it } from 'vitest';
import { API_BASE, PERSONA_IDS, SERVER_PORT, TIME_CONTROLS, TIME_CONTROL_IDS, WEB_DEV_PORT } from './index.ts';

describe('shared contracts', () => {
  it('exposes the eight personas of the bot ladder in order', () => {
    expect(PERSONA_IDS).toEqual(['petya', 'sonya', 'grisha', 'sasha', 'vika', 'lyova', 'nika', 'dima']);
  });

  it('has a time control entry for every id, keyed consistently', () => {
    for (const id of TIME_CONTROL_IDS) {
      expect(TIME_CONTROLS[id].id).toBe(id);
    }
    expect(TIME_CONTROLS.training.initialMs).toBeNull();
    expect(TIME_CONTROLS.bullet1.coachMode).toBe('off');
  });

  it('pins the local ports and API prefix used by the dev proxy and the launcher', () => {
    expect(API_BASE).toBe('/api');
    expect(SERVER_PORT).toBe(8787);
    expect(WEB_DEV_PORT).toBe(5173);
  });
});
