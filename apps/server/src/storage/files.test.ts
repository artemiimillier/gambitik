import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARENT_NOTES, PARENT_NOTES_END, PARENT_NOTES_START, WriteChain, allocateGameFileBase, atomicWriteFile, extractParentNotes, localDateParts, parentNotesBlock, readTextIfExists, resolveDataFile } from './files.ts';

const dir = mkdtempSync(join(tmpdir(), 'gambit-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('atomicWriteFile', () => {
  it('creates directories, replaces the file as a whole and leaves no temp files', async () => {
    const path = join(dir, 'a', 'b', 'note.md');
    await atomicWriteFile(path, 'первая версия');
    await atomicWriteFile(path, 'вторая версия');
    expect(readFileSync(path, 'utf8')).toBe('вторая версия');
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['note.md']);
    expect(await readTextIfExists(path)).toBe('вторая версия');
    expect(await readTextIfExists(join(dir, 'missing.md'))).toBeNull();
  });

  it('never leaves a half-written file behind when writing fails', async () => {
    const asDirectory = join(dir, 'is-a-dir');
    await atomicWriteFile(join(asDirectory, 'x.txt'), 'x');
    await expect(atomicWriteFile(asDirectory, 'cannot replace a directory')).rejects.toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('game file names', () => {
  it('uses the local start time and the persona, with _2, _3 … on collisions', () => {
    const iso = '2026-09-21T14:42:10.000Z';
    const p = localDateParts(iso);
    const stem = `games/${p.yyyy}/${p.mm}/${p.yyyy}-${p.mm}-${p.dd}_${p.hh}${p.min}_vs-petya`;
    expect(allocateGameFileBase(dir, iso, 'petya')).toBe(stem);
    expect(allocateGameFileBase(dir, iso, 'petya', (base) => base === stem)).toBe(`${stem}_2`);
    const abs = resolveDataFile(dir, `${stem}_2`);
    writeFileSync(join(dir, 'placeholder'), '');
    rmSync(join(dir, 'placeholder'));
    return atomicWriteFile(`${abs}.md`, 'x').then(() => {
      expect(allocateGameFileBase(dir, iso, 'petya', (base) => base === stem)).toBe(`${stem}_3`);
      expect(existsSync(`${abs}.md`)).toBe(true);
    });
  });

  it('refuses paths that leave the data directory', () => {
    expect(() => resolveDataFile(dir, '../outside')).toThrow(/escapes/);
    expect(() => resolveDataFile(dir, 'games/../../outside')).toThrow(/escapes/);
    expect(resolveDataFile(dir, 'games/2026/x')).toBe(join(dir, 'games', '2026', 'x'));
  });
});

describe('protected parent notes', () => {
  it('round-trips the parent text verbatim and falls back to the default block', () => {
    const text = '\n## Заметки родителя\n\n- По будням не больше 40 минут.\n';
    const file = `# Профиль\n\n${parentNotesBlock(text)}\n`;
    expect(extractParentNotes(file)).toBe(text);
    expect(parentNotesBlock(extractParentNotes(file))).toBe(`${PARENT_NOTES_START}${text}${PARENT_NOTES_END}`);
    expect(extractParentNotes(null)).toBeNull();
    expect(extractParentNotes('no markers')).toBeNull();
    expect(extractParentNotes(`${PARENT_NOTES_START} only the start marker`)).toBeNull();
    expect(parentNotesBlock(null)).toContain(DEFAULT_PARENT_NOTES);
  });
});

describe('WriteChain', () => {
  it('serialises jobs and survives failures', async () => {
    const chain = new WriteChain();
    const order: string[] = [];
    const slow = chain.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    const failing = chain.run(() => Promise.reject(new Error('disk full')));
    const fast = chain.run(() => {
      order.push('fast');
      return Promise.resolve();
    });
    await expect(failing).rejects.toThrow('disk full');
    await Promise.all([slow, fast]);
    await chain.idle();
    expect(order).toEqual(['slow', 'fast']);
  });
});
