/** Removes the temp DATA_DIR of this run (set GAMBIT_E2E_KEEP_DATA=1 to inspect the written files). */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export default function globalTeardown(): void {
  const dir = process.env.GAMBIT_E2E_DATA_DIR;
  if (!dir || process.env.GAMBIT_E2E_KEEP_DATA === '1') return;
  // only ever delete a directory this suite created: <os tmp>/gambit-e2e-XXXXXX
  const insideTmp = dirname(resolve(dir)) === resolve(tmpdir()) || dirname(resolve(dir)) === realpathSync(tmpdir());
  if (!insideTmp || !basename(dir).startsWith('gambit-e2e-')) return;
  rmSync(dir, { recursive: true, force: true });
}
