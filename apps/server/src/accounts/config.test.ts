/**
 * Accounts on (the public site): nothing paid or generative can be reached by strangers, whatever the environment says
 * Config only — no server is built here (the S5 guard of voiceGen/guards.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';

describe('the public site’s configuration', () => {
  it('M4: with accounts on, keys, runtime AI, codex and recording are off whatever the environment says', () => {
    const config = loadConfig({ GAMBIT_ACCOUNTS: '1', GAMBIT_RUNTIME_AI: '1', OPENAI_API_KEY: 'sk-test-x', OPENROUTER_API_KEY: 'sk-or-test-x', GAMBIT_CLIP_GEN: '1', LLM_PROVIDER: 'openrouter' }, { log: false, codexBin: '/usr/bin/true' });
    expect(config).toMatchObject({ runtimeAi: false, openaiApiKey: null, openrouterApiKey: null, codexBin: null, llmProvider: 'template', voicePreferred: 'clips' });
    expect(config.clipGen.enabled).toBe(false);
    expect(config.networkWarnings.join(' ')).toMatch(/GAMBIT_RUNTIME_AI, OPENAI_API_KEY, OPENROUTER_API_KEY, CODEX_BIN, GAMBIT_CLIP_GEN ignored/);
    // behind a proxy without GAMBIT_TRUST_PROXY: said aloud at start
    expect(loadConfig({ GAMBIT_ACCOUNTS: '1', GAMBIT_PUBLIC_HOSTS: 'gambitik.example.org' }, { log: false }).networkWarnings.join(' ')).toMatch(/GAMBIT_TRUST_PROXY/);
    // a short invite code closes sign-up rather than being guessable
    expect(loadConfig({ GAMBIT_ACCOUNTS: '1', GAMBIT_INVITE_CODE: 'short1' }, { log: false }).accounts.inviteCode).toBeNull();
  });

});
