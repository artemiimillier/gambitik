/**
 * «Дозапись новых фраз» in Settings (docs/voice-clips/ONDEMAND.md): the paid switch is shown only when the server can record (health
 * `clipGen` present and not off), never to an automated browser and never offline; off by default, it goes on only after
 * the confirmation with the price and the day's cap; the cap choices stop at the server's maximum; the spend, the counts,
 * the balance note and the pause reason read in plain Russian. Static render, fake routes: nothing is sent.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClipGenHealth, ClipGenPauseReason, ClipGenStatus } from '@gambit/shared';
import { ClipGenCard } from './ClipGenCard.tsx';
import type { ClipGenCardApi } from './ClipGenCard.tsx';
import {
  CLIP_GEN_BALANCE_NOTE,
  CLIP_GEN_CAP_CHOICES,
  CLIP_GEN_CLIPS_ONLY_RU,
  CLIP_GEN_PAUSE_RU,
  clipGenCapChoices,
  clipGenCardVisible,
  clipGenConfirmText,
  clipGenPauseRu,
  describeClipGen,
  formatCreditsRu,
} from './healthText.ts';
import { Settings } from './Settings.tsx';
import { sampleHealth, sampleProfile } from './testUtils.ts';

const noop = (): void => undefined;
const saved = () => Promise.resolve({ status: 'saved' as const, profile: sampleProfile() });
const READY: ClipGenHealth = { state: 'ready', overlay: true };

function status(patch: Partial<ClipGenStatus> = {}): ClipGenStatus {
  return {
    health: READY,
    enabled: false,
    queue: 0,
    busy: false,
    overlay: { version: 4, units: 12 },
    spent: { today: '2026-09-24', todayMilli: 1350, totalMilli: 12_600, prefetchMilli: 0 },
    caps: { dailyMilli: 3000, dailyMaxMilli: 10_000, totalMilli: 60_000 },
    givenUp: 2,
    ...patch,
  };
}

/** the routes are never called by a static render; they throw to prove it */
const NO_API: ClipGenCardApi = {
  status: () => Promise.reject(new Error('not in a static render')),
  save: () => Promise.reject(new Error('not in a static render')),
};

function card(o: { health?: ClipGenHealth | null; serverOnline?: boolean; automated?: boolean; status?: ClipGenStatus | null; clipsVoice?: boolean } = {}): string {
  const health = sampleHealth(o.health === null ? {} : { clipGen: o.health ?? READY });
  return renderToStaticMarkup(
    <ClipGenCard health={health} serverOnline={o.serverOnline ?? true} automated={o.automated ?? false} api={NO_API} initialStatus={o.status === undefined ? status() : o.status} now={() => 0} {...(o.clipsVoice !== undefined ? { clipsVoice: o.clipsVoice } : {})} />,
  );
}

/** the cap buttons of a rendered card: their labels, and the one pressed */
function capButtons(html: string): { labels: string[]; pressed: string[] } {
  const group = html.slice(html.indexOf('aria-label="Лимит дозаписи в день"'));
  const buttons = group.slice(0, group.indexOf('</div>'));
  const label = (b: string) => />([\d,]+ кр\.)</.exec(b)?.[1] ?? '';
  return {
    labels: (buttons.match(/<button[^]*?<\/button>/g) ?? []).map(label),
    pressed: (buttons.match(/aria-pressed="true"[^]*?<\/button>/g) ?? []).map(label),
  };
}

describe('«Дозапись новых фраз» — when the card shows', () => {
  it('only when the server can record: not without the feature, not when it is off in .env, not offline, never to automation', () => {
    expect(card()).toContain('Дозапись новых фраз');
    expect(card({ health: { state: 'paused', reason: 'parent-off', until: null, overlay: false } })).toContain('Дозапись новых фраз');
    expect(card({ health: null })).toBe('');
    expect(card({ health: { state: 'off', overlay: true } })).toBe('');
    expect(card({ serverOnline: false })).toBe('');
    expect(card({ automated: true })).toBe('');
    expect(clipGenCardVisible({ health: sampleHealth({ clipGen: READY }), serverOnline: true, automated: false })).toBe(true);
    expect(clipGenCardVisible({ health: null, serverOnline: true, automated: false })).toBe(false);
  });

  it('in Settings: absent for today\'s servers, present when the server records', () => {
    const plain = renderToStaticMarkup(<Settings profile={sampleProfile()} health={sampleHealth()} serverOnline saveStudent={saved} onExit={noop} onOpenPlayground={noop} />);
    expect(plain).not.toContain('Дозапись новых фраз');
    const recording = renderToStaticMarkup(<Settings profile={sampleProfile()} health={sampleHealth({ clipGen: READY })} serverOnline saveStudent={saved} onExit={noop} onOpenPlayground={noop} />);
    expect(recording).toContain('Дозапись новых фраз');
    // the status is asked for once the card is on screen: until then the switch waits
    expect(recording).toContain('Узнаю у сервера…');
    expect(recording).toMatch(/role="switch" aria-checked="false" disabled=""/);
  });
});

describe('«Дозапись новых фраз» — the card', () => {
  it('the switch mirrors the parent\'s setting (off by default); the confirmation names the price and the day\'s cap', () => {
    const off = card();
    expect(off).toMatch(/role="switch" aria-checked="false"/);
    expect(off).toContain('Записывать новые фразы');
    // the confirmation (in the closed dialog) with the chosen cap
    expect(off).toContain('Платно: ≈ 0,15–0,75 кредита Higgsfield за реплику, не больше 3 кредитов в день. В первый раз фраза сначала без голоса: голос — через несколько секунд или со следующего раза. Включить?');
    expect(card({ status: status({ enabled: true }) })).toMatch(/role="switch" aria-checked="true"/);
  });

  it('daily cap choices 3 / 6 / 10 / 15 credits, only up to the server\'s maximum; the current one pressed', () => {
    const html = card();
    const group = html.slice(html.indexOf('aria-label="Лимит дозаписи в день"'));
    const buttons = group.slice(0, group.indexOf('</div>'));
    expect(buttons).toContain('3 кр.');
    expect(buttons).toContain('6 кр.');
    expect(buttons).toContain('10 кр.');
    expect(buttons).not.toContain('15 кр.');
    const pressed = buttons.match(/aria-pressed="true"[^]*?<\/button>/g) ?? [];
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain('>3 кр.<');
    expect(CLIP_GEN_CAP_CHOICES).toEqual([3, 6, 10, 15]);
    expect(clipGenCapChoices(15_000)).toEqual([3000, 6000, 10_000, 15_000]);
    expect(clipGenCapChoices(30_000)).toEqual([3000, 6000, 10_000, 15_000]);
    // a maximum below the smallest choice is the one choice
    expect(clipGenCapChoices(1500)).toEqual([1500]);
    expect(clipGenCapChoices(0)).toEqual([]);
  });

  it('a maximum between the choices is a choice itself, and the pressed button is always the cap the server applies', () => {
    expect(clipGenCapChoices(5000)).toEqual([3000, 5000]);
    expect(clipGenCapChoices(7000)).toEqual([3000, 6000, 7000]);
    expect(clipGenCapChoices(12_000)).toEqual([3000, 6000, 10_000, 12_000]);
    // an older cap that is none of the choices (the maximum was 5 when the parent picked it)
    expect(clipGenCapChoices(15_000, 5000)).toEqual([3000, 5000, 6000, 10_000, 15_000]);
    // CLIP_GEN_DAILY_MAX=5: the server spends up to 5 a day — «5 кр.» is pressed, and the line says 5 too
    const five = card({ status: status({ enabled: true, caps: { dailyMilli: 5000, dailyMaxMilli: 5000, totalMilli: 60_000 } }) });
    expect(capButtons(five)).toEqual({ labels: ['3 кр.', '5 кр.'], pressed: ['5 кр.'] });
    expect(five).toContain('Сегодня: 1,35 из 5 кр.');
    const seven = card({ status: status({ enabled: true, caps: { dailyMilli: 7000, dailyMaxMilli: 7000, totalMilli: 60_000 } }) });
    expect(capButtons(seven)).toEqual({ labels: ['3 кр.', '6 кр.', '7 кр.'], pressed: ['7 кр.'] });
    const older = card({ status: status({ enabled: true, caps: { dailyMilli: 5000, dailyMaxMilli: 15_000, totalMilli: 60_000 } }) });
    expect(capButtons(older).pressed).toEqual(['5 кр.']);
  });

  it('the facts: today and total against the caps, what was recorded / queued / refused, the balance is not checked', () => {
    const html = card({ status: status({ enabled: true, queue: 1, spent: { today: '2026-09-24', todayMilli: 1350, totalMilli: 12_600, prefetchMilli: 20_000 } }) });
    expect(html).toContain('Сегодня: 1,35 из 3 кр. · всего: 12,6 из 60 кр. (потолок в .env).');
    expect(html).toContain('Заранее записано владельцем: на 20 кр.');
    // an older server reports only the takes in the folder (the owner's prefetch included): said as such
    expect(html).toContain('Записей в папке новых фраз: 12 · в очереди: 1 · не прошли проверку: 2.');
    expect(html).not.toContain('Новых фраз записано');
    // the phrases this server recorded during games — not the prefetch, not takes
    const recorded = card({ status: status({ enabled: true, recorded: 5, spent: { today: '2026-09-24', todayMilli: 1350, totalMilli: 12_600, prefetchMilli: 20_000 } }) });
    expect(recorded).toContain('Новых фраз записано: 5 · в очереди: 0 · не прошли проверку: 2.');
    // paid takes whose check could not run: the owner is told what to do, not «recording» for ever
    const stuck = describeClipGen(status({ enabled: true, stuck: 2 }), 0);
    expect(stuck.details).toContain('Не удалось обработать уже оплаченных записей: 2 — владельцу: перезапустите сервер, он попробует снова (платить заново не нужно).');
    expect(stuck.tone).toBe('warn');
    expect(html).toContain(CLIP_GEN_BALANCE_NOTE);
    expect(CLIP_GEN_BALANCE_NOTE).toBe('Баланс Higgsfield сервер не проверяет.');
    expect(html).toContain('Включено: новые фразы записываются, когда Гамбитик говорит их впервые.');
  });

  it('why it pauses, in Russian — a timed pause says until when; the parent\'s own switch off is not a «pause»', () => {
    const paused = card({ status: status({ enabled: true, health: { state: 'paused', reason: 'login', until: null, overlay: true } }) });
    expect(paused).toContain('На паузе. Вход в Higgsfield истёк — владельцу: higgsfield auth login.');
    expect(paused).toContain('data-tone="warn"');
    const off = describeClipGen(status({ enabled: false, health: { state: 'paused', reason: 'parent-off', until: null, overlay: true } }), 0);
    expect(off).toMatchObject({ tone: 'info', summary: 'Выключено: новые фразы остаются без голоса.' });
    const at = new Date(2026, 8, 24, 14, 30).getTime();
    expect(clipGenPauseRu({ state: 'paused', reason: 'rate', until: at, overlay: true }, at - 60_000)).toBe('Higgsfield просит подождать — продолжу чуть позже (до 14:30).');
    // a pause only a person can lift: its time is the next look, not the end of the problem
    expect(clipGenPauseRu({ state: 'paused', reason: 'login', until: at, overlay: true }, at - 60_000)).toBe('Вход в Higgsfield истёк — владельцу: higgsfield auth login; проверю снова в 14:30.');
    expect(clipGenPauseRu({ state: 'paused', reason: 'no-credits', until: at, overlay: true }, at - 60_000)).toBe('На счёте Higgsfield закончились кредиты; проверю снова в 14:30.');
    // the first setup without the line at all
    expect(CLIP_GEN_PAUSE_RU['data-dir']).toBe('Не задана или не совпадает папка данных: владельцу — строка CLIP_GEN_DATA_DIR в файле .env.');
    expect(clipGenPauseRu({ state: 'paused', reason: 'day-cap', until: at, overlay: true }, 0)).toBe('Дневной лимит исчерпан — продолжу завтра.');
    expect(clipGenPauseRu(READY)).toBeNull();
    // every reason has its sentence
    const reasons: ClipGenPauseReason[] = ['parent-off', 'no-budget', 'no-cli', 'no-tools', 'temp-data', 'data-dir', 'no-overlay', 'login', 'rate', 'failing', 'price', 'model', 'audit', 'tool-busy', 'day-cap', 'total-cap', 'duplicate', 'no-credits', 'unresolved'];
    for (const reason of reasons) expect(CLIP_GEN_PAUSE_RU[reason], reason).toMatch(/^[А-ЯЁA-Z].*[.!]$/u);
    expect(Object.keys(CLIP_GEN_PAUSE_RU).sort()).toEqual([...reasons].sort());
  });

  it('with another voice (or the sound off) nothing is ever recorded: the card says so instead of «записываются»', () => {
    const on = card({ status: status({ enabled: true }), clipsVoice: false });
    expect(on).toContain(`Включено, но сейчас ничего не записывается. ${CLIP_GEN_CLIPS_ONLY_RU}`);
    expect(on).not.toContain('записываются, когда');
    expect(on).toContain('data-tone="info"');
    const off = describeClipGen(status({ enabled: false }), 0, { clipsVoice: false });
    expect(off.details).toContain(CLIP_GEN_CLIPS_ONLY_RU);
    expect(card({ status: status({ enabled: true }), clipsVoice: true })).toContain('Включено: новые фразы записываются, когда Гамбитик говорит их впервые.');
    expect(CLIP_GEN_CLIPS_ONLY_RU).toBe('Работает только когда говорит «Записанный голос»: сейчас выбран другой голос или звук выключен.');
  });

  it('credits in Russian, the confirmation\'s grammar', () => {
    expect(formatCreditsRu(1350)).toBe('1,35');
    expect(formatCreditsRu(12_600)).toBe('12,6');
    expect(formatCreditsRu(3000)).toBe('3');
    expect(formatCreditsRu(150)).toBe('0,15');
    expect(formatCreditsRu(-5)).toBe('0');
    expect(clipGenConfirmText(1000)).toContain('не больше 1 кредита в день');
    expect(clipGenConfirmText(10_000)).toContain('не больше 10 кредитов в день');
    expect(clipGenConfirmText(1500)).toContain('не больше 1,5 кредита в день');
  });
});
