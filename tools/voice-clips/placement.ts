/**
 * «Дозапись голоса»: where the recorded overlay may live — ONE rule for the operator's tools (./overlay.ts
 * `resolveOverlayDir`) and the server (apps/server/src/config.ts, through its bridge), so a paid prefetch can never be
 * recorded into a folder the server then refuses to serve (docs/voice-clips/ONDEMAND.md). Also the one `.env` value the tools
 * need. Node-only, no side effects on import, nothing imported beyond node:fs and node:path.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Why a folder cannot be the overlay (the server logs it for the operator; it never reaches the browser). */
export type OverlayDirProblem = 'relative' | 'repo' | 'data' | 'dist';

/** The real path of `path`, or of its nearest existing ancestor with the rest appended (a folder not created yet). */
export function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  try {
    head = realpathSync(head);
  } catch {
    // unreadable: compare the resolved path
  }
  return join(head, ...tail);
}

/** `child` is `parent` or lies inside it. */
export function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why a folder cannot be the overlay: not absolute; inside (or around) a git checkout — this one or ANY other, since
 * `git clean -fdx` would delete paid audio and every worktree would get its own budget (S3); inside (or around) DATA_DIR
 * — the child's data; inside (or around) the served SPA build. null = fine. Symlinks are resolved first
 * (/tmp → /private/tmp).
 */
export function overlayDirProblem(dir: string, places: { repoRoot: string; dataDir: string; webDistDir: string }): OverlayDirProblem | null {
  if (!isAbsolute(dir)) return 'relative';
  const real = realish(dir);
  const repo = realish(places.repoRoot);
  if (within(real, repo) || within(repo, real)) return 'repo';
  for (let d = real; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return 'repo';
    if (dirname(d) === d) break;
  }
  const data = realish(places.dataDir);
  if (within(real, data) || within(data, real)) return 'data';
  const dist = realish(places.webDistDir);
  if (within(real, dist) || within(dist, real)) return 'dist';
  return null;
}

/**
 * ONE value of a `.env` file (undefined = the file or the line is missing). The server loads `.env` with node's
 * `--env-file-if-exists`; the voice tools run without it, so the few settings they share with the server
 * (VOICE_OVERLAY_DIR, DATA_DIR) are read one by one — never the whole file: no key or token from it ever reaches a tool
 * or its children. The syntax is node's: `NAME=value`, optional `export `, quotes, `#` comments.
 */
export function dotEnvValue(file: string, name: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let value: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m || m[1] !== name) continue;
    let v = (m[2] as string).trim();
    const quote = v[0];
    if ((quote === '"' || quote === "'" || quote === '`') && v.indexOf(quote, 1) > 0) v = v.slice(1, v.indexOf(quote, 1));
    else v = v.replace(/\s+#.*$/, '').trim();
    // the last line wins, as with node's loader
    value = v;
  }
  return value;
}
