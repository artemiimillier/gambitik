/**
 * «Дозапись голоса» guards that live in files, not in code paths (docs/voice-clips/ONDEMAND.md): only the bridge imports the
 * tools; every automated stack (both Playwright configs, every local .claude/launch.json config when present) runs with recording off, no
 * Higgsfield CLI and no overlay; the e2e global setup refuses a server that could record; and no test turns
 * GAMBIT_CLIP_GEN on while building a server without a fake runner.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { healthSafetyProblem } from '../../../../e2e/global-setup.ts';
import type { SafetyHealth } from '../../../../e2e/global-setup.ts';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');
const GUARD_ENV = { GAMBIT_CLIP_GEN: '0', HIGGSFIELD_BIN: 'off', VOICE_OVERLAY_DIR: 'off' } as const;

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

/** Every module specifier a file imports or re-exports from (static and dynamic). */
function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  for (const m of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  return out;
}

describe('the server reaches the voice-clip tools only through voiceGen/bridge.ts', () => {
  it('no other server file imports anything under tools/', () => {
    const files = walk(SERVER_SRC, (f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((f) => !f.endsWith(join('voiceGen', 'bridge.ts')))
      .flatMap((f) => specifiers(readFileSync(f, 'utf8')).filter((s) => /(^|\/)tools\//.test(s)).map((s) => `${relative(REPO, f)} → ${s}`));
    expect(offenders).toEqual([]);
    // and the bridge itself only reaches into tools/voice-clips
    const bridge = specifiers(readFileSync(join(SERVER_SRC, 'voiceGen', 'bridge.ts'), 'utf8'));
    expect(bridge.length).toBeGreaterThan(5);
    for (const s of bridge) expect(s).toMatch(/^\.\.\/\.\.\/\.\.\/\.\.\/tools\/voice-clips\/[a-z]+\.ts$/);
  });
});

describe('automated stacks never record (D10)', () => {
  it('both Playwright configs start the server with recording off, no CLI and no overlay', () => {
    for (const config of ['playwright.config.ts', 'playwright.prod.config.ts']) {
      const text = readFileSync(join(REPO, config), 'utf8');
      const env = /webServer:\s*\{[\s\S]*?env:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? '';
      for (const [name, value] of Object.entries(GUARD_ENV)) expect(env, `${config}: ${name}`).toMatch(new RegExp(`\\b${name}:\\s*'${value}'`));
    }
  });

  // .claude/ is git-ignored (local preview configs); the check runs wherever a developer keeps one
  const LAUNCH = join(REPO, '.claude', 'launch.json');
  it.skipIf(!existsSync(LAUNCH))('every local .claude/launch.json config sets the three guards before its command', () => {
    const launch = JSON.parse(readFileSync(LAUNCH, 'utf8')) as { configurations: { name: string; runtimeExecutable: string; runtimeArgs: string[] }[] };
    expect(launch.configurations.length).toBeGreaterThan(0);
    for (const c of launch.configurations) {
      // `env A=1 B=2 cmd …`: only the assignments before the first other word reach the command
      expect(c.runtimeExecutable, c.name).toBe('env');
      const assignments = c.runtimeArgs.slice(0, c.runtimeArgs.findIndex((a) => !/^[A-Z_][A-Z0-9_]*=/.test(a)));
      for (const [name, value] of Object.entries(GUARD_ENV)) expect(assignments, `${c.name}: ${name}`).toContain(`${name}=${value}`);
    }
  });

  it('the e2e global setup refuses any server whose health does not say clipGen off', () => {
    const base: SafetyHealth = { ok: true, llm: { codexCli: false, codexLoggedIn: false, openaiKey: false }, voice: { realtime: false }, puzzles: { count: 25 } };
    expect(healthSafetyProblem({ ...base, clipGen: { state: 'off' } })).toBeNull();
    expect(healthSafetyProblem({ ...base, clipGen: { state: 'ready' } })).toMatch(/Higgsfield/);
    expect(healthSafetyProblem({ ...base, clipGen: { state: 'paused', reason: 'parent-off' } })).toMatch(/GAMBIT_CLIP_GEN=0/);
    expect(healthSafetyProblem({ ...base, clipGen: { state: 'paused', reason: 'temp-data' } })).not.toBeNull();
    expect(healthSafetyProblem(base)).toMatch(/not reported/);
    expect(healthSafetyProblem({ ...base, llm: { ...base.llm, openaiKey: true }, clipGen: { state: 'off' } })).toMatch(/OpenAI/);
    // every problem starts with «e2e» (the setup rethrows those instead of retrying)
    expect(healthSafetyProblem({ ...base, clipGen: { state: 'ready' } })).toMatch(/^e2e/);
  });
});

describe('no test turns recording on without a fake runner (S5)', () => {
  it('a test file that sets GAMBIT_CLIP_GEN on and builds a server injects a fake `runCli`', () => {
    const tests = [
      ...walk(join(REPO, 'apps'), (f) => /\.test\.tsx?$/.test(f)),
      ...walk(join(REPO, 'packages'), (f) => /\.test\.tsx?$/.test(f)),
      ...walk(join(REPO, 'tools'), (f) => /\.test\.ts$/.test(f)),
      ...walk(join(REPO, 'e2e'), (f) => /\.ts$/.test(f)),
    ];
    expect(tests.length).toBeGreaterThan(100);
    const ON = /GAMBIT_CLIP_GEN['"]?\s*[:=]\s*['"`]?\s*(?:1|true|yes|on)\b/i;
    const BUILDS = /\b(?:createTestServer|createEnvTestServer|createServerContext|createClipGenService|new ClipGenService|loadConfig\(\s*process\.env)\b/;
    const offenders = tests.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return ON.test(text) && BUILDS.test(text) && !/\brunCli\s*:/.test(text);
    });
    expect(offenders.map((f) => relative(REPO, f))).toEqual([]);
    // the e2e specs never switch it on at all
    expect(walk(join(REPO, 'e2e'), (f) => f.endsWith('.ts')).filter((f) => ON.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
