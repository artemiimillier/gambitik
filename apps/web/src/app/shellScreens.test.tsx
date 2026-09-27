/** Static-markup smoke tests of the shell screens (no DOM, no effects). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CURRICULUM } from '@gambit/content';
import type { CoachStyle, TimeControlId } from '@gambit/shared';
import { Home } from './Home.tsx';
import { CoachStylePicker } from './NewGame.tsx';
import { ParentGate } from './ParentGate.tsx';
import { Settings, stageDescriptionRu } from './Settings.tsx';
import { sampleGame, sampleHealth, sampleProfile } from './testUtils.ts';

const noop = (): void => undefined;
const saved = () => Promise.resolve({ status: 'saved' as const, profile: sampleProfile() });

describe('Settings page — with runtime AI (GAMBIT_RUNTIME_AI on)', () => {
  const html = renderToStaticMarkup(
    <Settings
      profile={sampleProfile({ stage: 3 })}
      health={sampleHealth({ voice: { realtime: true, model: 'gpt-realtime-2.1', voice: 'marin', live: true, liveModel: 'gpt-live-1', preferred: 'live' }, ai: { runtime: true } })}
      serverOnline
      saveStudent={saved}
      onExit={noop}
      onOpenPlayground={noop}
    />,
  );

  it('offers the five voices and the two microphone modes asked for', () => {
    for (const title of ['Авто (лучший доступный)', 'Живой голос — слушает и говорит одновременно', 'Живой голос (gpt-realtime)', 'Голос компьютера', 'Выключен', 'Всегда слушает', 'По кнопке']) {
      expect(html, title).toContain(title);
    }
    expect(html).toContain('gpt-live-1');
    expect(html).toContain('Ключ OpenAI на этом компьютере');
  });

  it('lets the parent set the curriculum stage, with a short description of every stage', () => {
    expect(html).toContain('Ступень обучения');
    expect(html.match(/role="radio"/g)).toHaveLength(CURRICULUM.length);
    expect(html.match(/role="radio" aria-checked="true"/g)).toHaveLength(1);
    for (const stage of CURRICULUM) expect(html).toContain(stage.title);
    expect(stageDescriptionRu({ ratingBand: '600–800', goal: 'Ставить мат в один ход.' })).toBe('600–800. Ставить мат в один ход.');
    expect(stageDescriptionRu({ ratingBand: ' ', goal: 'Цель.' })).toBe('Цель.');
  });

  it('lets the parent choose how the live conversation works: auto-start and how talkative the coach is (default «Обычно»)', () => {
    expect(html).toContain('Разговор с живым голосом');
    expect(html).toContain('Разговор включается сам в начале партии');
    expect(html).toContain('«Поговорить»');
    for (const title of ['Тихо', 'Обычно', 'Болтливо']) expect(html, title).toContain(title);
    // the default is «Обычно»: exactly that tile is pressed inside the group
    const group = html.slice(html.indexOf('aria-label="Как часто Гамбитик говорит сам"'));
    const pressed = group.slice(0, group.indexOf('</div>', group.indexOf('Болтливо'))).match(/aria-pressed="true"[^]*?<\/button>/g) ?? [];
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain('Обычно');
  });

  it('lets the parent cap the paid voice per day (default 60 minutes), with the price hint and the rules', () => {
    expect(html).toContain('Лимит живого голоса в день');
    for (const title of ['30 мин', '60 мин', '90 мин', '120 мин', 'Без лимита']) expect(html, title).toContain(title);
    const group = html.slice(html.indexOf('aria-label="Лимит живого голоса в день"'));
    const pressed = group.slice(0, group.indexOf('</div>')).match(/aria-pressed="true"[^]*?<\/button>/g) ?? [];
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain('60 мин');
    expect(html).toContain('≈ $0,05 за минуту, 60 минут ≈ $3.');
    expect(html).toContain('Не больше 60 минут живого голоса в день');
    expect(html).toContain('через 2 минуты без ходов и слов ребёнка');
  });

  it('is honest about what leaves the computer', () => {
    expect(html).toContain('серверах OpenAI');
    expect(html).not.toContain('никуда не отправляется');
  });
});

describe('Settings page — no generative AI in the child\'s game (docs/TEACHING.md §4.4, the default)', () => {
  // the keys are on the server, the flag is off: nothing of the live voice may be offered
  const health = sampleHealth({
    voice: { realtime: false, model: 'gpt-realtime-2.1', voice: 'marin', live: false, preferred: 'clips' },
    llm: { codexCli: true, codexLoggedIn: true, openaiKey: true, openrouterKey: true },
    ai: { runtime: false },
  });
  const html = renderToStaticMarkup(<Settings profile={sampleProfile({ stage: 3 })} health={health} serverOnline saveStudent={saved} onExit={noop} onOpenPlayground={noop} />);
  const pressed = (markup: string): string[] => markup.match(/aria-pressed="true"[^]*?<\/button>/g) ?? [];

  it('three voices, «Записанный голос» pressed by default, and the line that the live voice is off', () => {
    const group = html.slice(html.indexOf('aria-label="Голос в партии"'));
    const tiles = group.slice(0, group.indexOf('</div>')).match(/<button[^]*?<\/button>/g) ?? [];
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toContain('Записанный голос');
    expect(tiles[1]).toContain('Голос компьютера — черновик');
    expect(tiles[2]).toContain('Без голоса');
    expect(pressed(group.slice(0, group.indexOf('</div>')))).toHaveLength(1);
    expect(pressed(group.slice(0, group.indexOf('</div>')))[0]).toContain('Записанный голос');
    expect(html).toContain('Живой голос выключен: в партии ребёнка ИИ не используется.');
  });

  it('no live voice, microphone, conversation, daily limit or OpenAI voice picker', () => {
    for (const gone of [
      'Авто (лучший доступный)',
      'Живой голос — слушает и говорит одновременно',
      'Живой голос (gpt-realtime)',
      '>Микрофон<',
      'Всегда слушает',
      'По кнопке',
      'Ребёнок в наушниках',
      'Разговор с живым голосом',
      'Разговор включается сам',
      'Как часто Гамбитик говорит сам',
      'Лимит живого голоса в день',
      'Каким голосом говорит Гамбитик',
      'Проверка звука и микрофона',
      'role="radiogroup" aria-label="Голос Гамбитика"',
      'OPENAI_API_KEY',
    ]) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('the key line says the key is not used; the reviews are templates; the footer says nothing leaves for an AI service', () => {
    expect(html).toContain('Ключ OpenAI на этом компьютере: есть, но в партии ребёнка он не используется');
    expect(html).toContain('Разборы партий и темы «Учителя» собираются из готовых шаблонов');
    expect(html).not.toContain('подписке ChatGPT');
    expect(html).toContain('ИИ выключен: ни звук, ни партии не уходят в OpenAI');
    expect(html).not.toContain('серверах OpenAI');
  });

  it('«Звуки»: the voice, the move sounds and the parent\'s permanent «Всегда без звука» (off by default)', () => {
    const sounds = html.slice(html.indexOf('>Звуки<'));
    expect(sounds).toContain('Голос Гамбитика');
    expect(sounds).toContain('Звуки ходов и кнопок');
    expect(sounds).toMatch(/role="switch" aria-checked="false"[^]*?Всегда без звука/);
    expect(sounds).toContain('Кнопка «Звук» в партии выключает голос и звуки ходов до полуночи');
  });

  it('a stored «live» or «auto» shows as the recorded voice (never rewritten); an old server without the flag is off too', () => {
    const oldServer = renderToStaticMarkup(
      <Settings
        profile={sampleProfile()}
        health={sampleHealth({ voice: { realtime: true, model: 'gpt-realtime-2.1', voice: 'marin', live: true, liveModel: 'gpt-live-1', preferred: 'live' } })}
        serverOnline
        saveStudent={saved}
        onExit={noop}
        onOpenPlayground={noop}
      />,
    );
    expect(oldServer).toContain('Живой голос выключен');
    expect(oldServer).not.toContain('Живой голос — слушает и говорит одновременно');
    // the server is down: no AI either
    const offline = renderToStaticMarkup(<Settings profile={sampleProfile()} health={null} serverOnline={false} saveStudent={saved} onExit={noop} onOpenPlayground={noop} />);
    expect(offline).toContain('Живой голос выключен');
  });
});

describe('parent gate', () => {
  it('keeps the page title, explains the hold and offers the sum as the second way in', () => {
    const html = renderToStaticMarkup(<ParentGate onPass={noop} onExit={noop} />);
    expect(html).toContain('Настройки');
    expect(html).toContain('Страница для взрослых');
    expect(html).toContain('Нажать и держать 3 секунды');
    expect(html).toMatch(/сколько будет \d\d \+ \d\d\?/);
    expect(html).not.toContain('Голос Гамбитика'); // nothing of the settings leaks through the gate
  });
});

describe('Home', () => {
  const base = { profile: sampleProfile(), games: [sampleGame()], reviewedToday: [], onNavigate: noop, now: new Date(2026, 8, 21, 16, 0, 0) };

  it('shows «Продолжить партию» only when an interrupted game waits', () => {
    expect(renderToStaticMarkup(<Home {...base} />)).not.toContain('Продолжить партию');
    const html = renderToStaticMarkup(
      <Home
        {...base}
        resume={{ route: { name: 'play', personaId: 'sasha', timeControlId: 'rapid10', childColor: 'w', coachStyle: 'teacher', examMode: false }, personaId: 'sasha', movesPlayed: 12 }}
      />,
    );
    expect(html).toContain('Продолжить партию');
    expect(html).toContain('Саша');
    expect(html).toContain('12 ходов');
  });

  it('counts the warm-up puzzles in the plan', () => {
    expect(renderToStaticMarkup(<Home {...base} puzzlesToday={1} />)).toContain('Ещё две задачи для разгона');
    expect(renderToStaticMarkup(<Home {...base} />)).toContain('Три задачи для разгона');
  });
});

describe('new-game wizard, step 3: «Как помогает Гамбитик?» (TEACHER-MODE §1.3)', () => {
  const picker = (timeControlId: TimeControlId, value: CoachStyle): string => renderToStaticMarkup(<CoachStylePicker timeControlId={timeControlId} value={value} onChange={noop} />);
  const pressedTiles = (html: string): string[] => html.match(/aria-pressed="true"[^]*?<\/button>/g) ?? [];
  const tiles = (html: string): string[] => html.match(/<button[^]*?<\/button>/g) ?? [];

  it('shows three big tiles for 10 minutes and training, with the chosen one pressed', () => {
    for (const tc of ['rapid10', 'training'] as const) {
      const html = picker(tc, 'teacher');
      expect(html).toContain('Как помогает Гамбитик?');
      expect(html).toContain('role="group"');
      expect(tiles(html)).toHaveLength(3);
      for (const title of ['Учитель', 'Подсказчик', 'Экзамен', 'Объясняет каждый ход и показывает хорошие ходы', 'Помогает, когда попросишь', 'Без подсказок']) {
        expect(html, title).toContain(title);
      }
      for (const icon of ['🎓', '💡', '🏆']) expect(html).toContain(icon);
      expect(pressedTiles(html)).toHaveLength(1);
      expect(pressedTiles(html)[0]).toContain('Учитель');
      expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
      // the line under the tiles explains the chosen style
      expect(html).toContain('покажет стрелками хорошие ходы');
    }
  });

  it('shows three tiles for 5 minutes — the teacher too, the child\'s clock stands while he speaks', () => {
    const html = picker('blitz5', 'helper');
    expect(tiles(html)).toHaveLength(3);
    expect(html).toContain('Учитель');
    expect(pressedTiles(html)[0]).toContain('Подсказчик');
  });

  it('marks «Экзамен» when it is chosen and says what it means', () => {
    const html = picker('rapid10', 'exam');
    expect(pressedTiles(html)).toHaveLength(1);
    expect(pressedTiles(html)[0]).toContain('Экзамен');
    expect(html).toContain('Гамбитик молчит всю партию');
  });

  it('bullet: a plain note instead of a choice — he only greets, and where the teacher is', () => {
    const html = picker('bullet1', 'helper');
    expect(tiles(html)).toHaveLength(0);
    expect(html).toContain('В молнии Гамбитик только поздоровается, а поговорим после партии.');
    expect(html).toContain('«Учитель» есть в играх на 5 и 10 минут и «Без часов».');
  });

  it('never names a colour, so «Белые» / «Чёрные» stay the only colour buttons (e2e finds them by name)', () => {
    expect(picker('training', 'teacher')).not.toMatch(/Белые|Чёрные|Сюрприз/);
  });
});
