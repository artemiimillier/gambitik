import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachEvent, CoachToolHost } from '@gambit/shared';
import { BRIEF_RESPONSE_INSTRUCTIONS_RU, CLARIFY_MOVE_FACTS_RU, buildBriefItem, clarifyPieceMoveFacts, hintFacts } from './coachBrief.ts';
import { OPEN_MIC_TURN_DETECTION, REALTIME_TOOLS, buildContextNote, buildSayInstruction, createRealtimeProtocol, sanitizeAnnotations } from './realtimeProtocol.ts';
import type { RealtimeClientEvent, RealtimeProtocol } from './realtimeProtocol.ts';
import { makeEvent } from './testUtils.ts';
import type { SayProgress, SpeakOutcome } from './voiceTypes.ts';

interface Harness {
  protocol: RealtimeProtocol;
  sent: RealtimeClientEvent[];
  transcripts: string[];
  captions: string[];
  audio: boolean[];
  thinking: boolean[];
  toolEvents: CoachEvent[];
  childSpeaking: boolean[];
  progress: SayProgress[];
  host: { current: CoachToolHost | null };
  types(): string[];
}

function setup(): Harness {
  const sent: RealtimeClientEvent[] = [];
  const transcripts: string[] = [];
  const captions: string[] = [];
  const audio: boolean[] = [];
  const thinking: boolean[] = [];
  const toolEvents: CoachEvent[] = [];
  const childSpeaking: boolean[] = [];
  const progress: SayProgress[] = [];
  const host: { current: CoachToolHost | null } = { current: null };
  const protocol = createRealtimeProtocol({
    send: (event) => sent.push(event),
    getToolHost: () => host.current,
    onTranscript: (who, text) => transcripts.push(`${who}: ${text}`),
    onCoachTranscriptDelta: (text) => captions.push(text),
    onOutputAudio: (active) => audio.push(active),
    onThinking: (value) => thinking.push(value),
    onToolCoachEvent: (event) => toolEvents.push(event),
    onChildSpeaking: (value) => childSpeaking.push(value),
    onSayProgress: (p) => progress.push(p),
  });
  return { protocol, sent, transcripts, captions, audio, thinking, toolEvents, childSpeaking, progress, host, types: () => sent.map((e) => e.type) };
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

/** loose view of a sent client event for assertions */
function view<T>(event: RealtimeClientEvent | undefined): T {
  return event as unknown as T;
}
const outputOf = (event: RealtimeClientEvent | undefined): string => view<{ item: { output: string } }>(event).item.output;

function created(id: string, say = true): unknown {
  return { type: 'response.created', response: { id, metadata: say ? { source: 'gambit-say' } : null } };
}
function done(id: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'response.done', response: { id, status: 'completed', output: [], ...extra } };
}

describe('realtime protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('configureSession registers Russian-described tools and turns server VAD off (push-to-talk)', () => {
    const h = setup();
    h.protocol.configureSession();
    expect(h.sent).toHaveLength(1);
    const update = view<{ type: string; session: { type: string; tools: unknown[]; audio: { input: { turn_detection: unknown } } } }>(h.sent[0]);
    expect(update.type).toBe('session.update');
    expect(update.session.type).toBe('realtime');
    expect(update.session.audio.input.turn_detection).toBeNull();
    expect(update.session.tools).toBe(REALTIME_TOOLS);
    const names = REALTIME_TOOLS.map((t) => t.name);
    expect(names).toEqual(['analyze_position', 'evaluate_move', 'compare_move', 'get_hint', 'explain_last_move', 'show_on_board', 'take_back_move', 'wait_for_user']);
    for (const tool of REALTIME_TOOLS) expect(String(tool.description)).toMatch(/[а-яё]/i);
    // «А что хочет сделать соперник?» must get the position facts, not the next HINT step
    const description = (name: string): string => String(REALTIME_TOOLS.find((t) => t.name === name)?.description);
    expect(description('analyze_position')).toMatch(/что хочет соперник/);
    // the clocks are never read out — the facts carry none, and the answer never retells the obvious
    expect(description('analyze_position')).not.toMatch(/кто ходит|, часы\./);
    expect(description('analyze_position')).toMatch(/очевидное — время на часах, цвет фигур, чей ход — не пересказывай/);
    expect(description('get_hint')).toMatch(/это не просьба о подсказке/);
    // every description says WHEN to call it; none asks to relay a text close to the letter
    expect(description('evaluate_move')).toMatch(/Вызывай всякий раз, когда ребёнок называет конкретный ход/);
    expect(description('explain_last_move')).toMatch(/почему это плохо/);
    for (const tool of REALTIME_TOOLS) expect(String(tool.description)).not.toMatch(/близко к тексту|дословно/);
    const evaluate = REALTIME_TOOLS.find((t) => t.name === 'evaluate_move') as { parameters: { required: string[] } } | undefined;
    expect(evaluate?.parameters.required).toEqual(['move']);
  });

  describe('speak', () => {
    it('sends a Russian system instruction + response.create and resolves when the audio has stopped', async () => {
      const h = setup();
      let resolved: SpeakOutcome | null = null;
      void h.protocol.speak('Ход  конём!\nОтлично!').then((v) => (resolved = v));
      await flush();

      expect(h.types()).toEqual(['conversation.item.create', 'response.create']);
      expect(h.sent[0]).toEqual({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Скажи ребёнку дословно, тёплым голосом: «Ход конём! Отлично!»' }] },
      });
      const response = view<{ response: { tool_choice: string; instructions: string; metadata: { source: string } } }>(h.sent[1]).response;
      expect(response.tool_choice).toBe('none');
      expect(response.instructions).toMatch(/дословно/);

      h.protocol.handleServerEvent(created('resp_1'));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started', response_id: 'resp_1' });
      h.protocol.handleServerEvent(done('resp_1'));
      await flush();
      expect(resolved).toBeNull(); // generation is done, playback is not

      h.protocol.handleServerEvent({ type: 'output_audio_buffer.stopped', response_id: 'resp_1' });
      await flush();
      expect(resolved).toBe('spoken');
      expect(h.audio).toEqual([true, false]);
    });

    it("resolves 'failed' when the response fails, so the fallback voice can say the phrase", async () => {
      const h = setup();
      const spoken = h.protocol.speak('Привет!');
      await flush();
      h.protocol.handleServerEvent(created('resp_1'));
      h.protocol.handleServerEvent(done('resp_1', { status: 'failed' }));
      expect(await spoken).toBe('failed');
    });

    it('gives up after a short grace period when no audio ever starts', async () => {
      const h = setup();
      let resolved: SpeakOutcome | null = null;
      void h.protocol.speak('Привет!').then((v) => (resolved = v));
      await flush();
      h.protocol.handleServerEvent(created('resp_1'));
      h.protocol.handleServerEvent(done('resp_1'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(resolved).toBeNull();
      await vi.advanceTimersByTimeAsync(600);
      expect(resolved).toBe('failed');
    });

    it('has an overall timeout so a silent server cannot hang the coach', async () => {
      const h = setup();
      let resolved: SpeakOutcome | null = null;
      void h.protocol.speak('Привет!').then((v) => (resolved = v));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(resolved).toBe('failed');
    });

    it('interrupt cancels an active model response and clears the WebRTC output buffer first', async () => {
      const h = setup();
      h.protocol.handleServerEvent(created('resp_model', false));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started' });
      expect(h.protocol.responseActive).toBe(true);

      void h.protocol.speak('Стоп-стоп!', { interrupt: true });
      await flush();
      expect(h.types()).toEqual(['response.cancel', 'output_audio_buffer.clear', 'conversation.item.create', 'response.create']);
    });

    it('without interrupt it waits for the model to finish its own answer', async () => {
      const h = setup();
      h.protocol.handleServerEvent(created('resp_model', false));
      void h.protocol.speak('Потом скажу.');
      await flush();
      expect(h.sent).toEqual([]);
      h.protocol.handleServerEvent(done('resp_model'));
      await flush();
      expect(h.types()).toEqual(['conversation.item.create', 'response.create']);
    });

    it('a second interrupting speak settles the first one as interrupted (never repeated by the fallback)', async () => {
      const h = setup();
      const first = h.protocol.speak('первая');
      await flush();
      h.protocol.handleServerEvent(created('resp_1'));
      const second = h.protocol.speak('вторая', { interrupt: true });
      expect(await first).toBe('interrupted');
      await flush();
      h.protocol.handleServerEvent(done('resp_1', { status: 'cancelled' }));
      h.protocol.handleServerEvent(created('resp_2'));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started' });
      h.protocol.handleServerEvent(done('resp_2'));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.stopped' });
      expect(await second).toBe('spoken');
    });

    it('retries once when response.create raced with an active response', async () => {
      const h = setup();
      void h.protocol.speak('Привет!');
      await flush();
      h.protocol.handleServerEvent({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'busy' } });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.types()).toEqual(['conversation.item.create', 'response.create', 'response.cancel', 'response.create']);
    });

    it('reset() settles a pending phrase (connection lost)', async () => {
      const h = setup();
      const spoken = h.protocol.speak('Привет!');
      await flush();
      h.protocol.reset();
      expect(await spoken).toBe('failed');
    });

    it('reset() in the middle of a phrase does not make the fallback repeat it', async () => {
      const h = setup();
      const spoken = h.protocol.speak('Привет!');
      await flush();
      h.protocol.handleServerEvent(created('resp_1'));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started' });
      h.protocol.reset();
      expect(await spoken).toBe('interrupted');
    });

    it('cancelOutput() (the app stops the coach) settles the phrase as interrupted', async () => {
      const h = setup();
      const spoken = h.protocol.speak('Привет!');
      await flush();
      h.protocol.handleServerEvent(created('resp_1'));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started' });
      h.sent.length = 0;
      h.protocol.cancelOutput();
      expect(h.types()).toEqual(['response.cancel', 'output_audio_buffer.clear']);
      expect(await spoken).toBe('interrupted');
    });

    it('builds the verbatim instruction in Russian', () => {
      expect(buildSayInstruction('  Дай копыто!  ')).toBe('Скажи ребёнку дословно, тёплым голосом: «Дай копыто!»');
    });
  });

  describe('speakBrief: the model says the situation in its own words', () => {
    const BRIEF = 'Ребёнок нашёл вилку конём. Цель: коротко похвалить за то, что проверил ходы соперника.';

    it('system item with the situation + response.create whose instructions ask for its OWN words (never «verbatim»)', async () => {
      const h = setup();
      void h.protocol.speakBrief(BRIEF);
      await flush();
      expect(h.types()).toEqual(['conversation.item.create', 'response.create']);
      expect(h.sent[0]).toEqual({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: buildBriefItem(BRIEF) }] },
      });
      const response = view<{ response: { tool_choice: string; instructions: string; metadata: { source: string } } }>(h.sent[1]).response;
      expect(response.instructions).toBe(BRIEF_RESPONSE_INSTRUCTIONS_RU);
      expect(response.instructions).toMatch(/своими словами, одно–два коротких предложения/);
      // nothing the child already sees — the clock, the colours, whose turn
      expect(response.instructions).toMatch(/не пересказывай очевидное — время на часах/);
      expect(response.instructions).toMatch(/Все факты передай точно/);
      expect(response.instructions).not.toMatch(/дословно|близко к тексту/);
      expect(response.metadata.source).toBe('gambit-brief');
      expect(h.progress).toEqual([{ type: 'sent' }]);
    });

    it("the model's words become captions of the phrase (not a free answer) and reach the journal; completes like speak()", async () => {
      const h = setup();
      let resolved: SpeakOutcome | null = null;
      void h.protocol.speakBrief(BRIEF).then((v) => (resolved = v));
      await flush();
      h.protocol.handleServerEvent({ type: 'response.created', response: { id: 'resp_b', metadata: { source: 'gambit-brief' } } });
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started', response_id: 'resp_b' });
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.delta', response_id: 'resp_b', delta: 'Ого, вилка! ' });
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.delta', response_id: 'resp_b', delta: 'Ты всё проверил.' });
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.done', response_id: 'resp_b', transcript: 'Ого, вилка! Ты всё проверил.' });
      h.protocol.handleServerEvent(done('resp_b'));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.stopped', response_id: 'resp_b' });
      await flush();
      expect(resolved).toBe('spoken');
      expect(h.progress).toEqual([
        { type: 'sent' },
        { type: 'caption', text: 'Ого, вилка!' },
        { type: 'caption', text: 'Ого, вилка! Ты всё проверил.' },
        { type: 'caption', text: 'Ого, вилка! Ты всё проверил.' },
      ]);
      expect(h.captions).toEqual([]);
      expect(h.transcripts).toEqual(['coach: Ого, вилка! Ты всё проверил.']);
    });

    it('teacher mode: the brief\'s sentence budget replaces «одно–два» in the per-response instructions (and survives a retry)', async () => {
      const h = setup();
      void h.protocol.speakBrief(BRIEF, { maxSentences: 1 });
      await flush();
      const short = view<{ response: { instructions: string } }>(h.sent[1]).response.instructions;
      expect(short).toMatch(/своими словами, одно короткое предложение, не больше/);
      expect(short).not.toMatch(/одно–три|одно–два/);
      // the server refuses the response (another one is running): the retry keeps the budget
      h.protocol.handleServerEvent({ type: 'error', error: { code: 'conversation_already_has_active_response' } });
      await vi.advanceTimersByTimeAsync(2000);
      const retried = h.sent.filter((e) => e.type === 'response.create').map((e) => view<{ response: { instructions: string } }>(e).response.instructions);
      for (const instructions of retried) expect(instructions).toMatch(/одно короткое предложение, не больше/);

      const full = setup();
      void full.protocol.speakBrief(BRIEF, { maxSentences: 4 });
      await flush();
      expect(view<{ response: { instructions: string } }>(full.sent[1]).response.instructions).toMatch(/до четырёх коротких предложений, не больше/);
    });

    it('a model response that is not ours is not taken for the brief (metadata)', async () => {
      const h = setup();
      void h.protocol.speakBrief(BRIEF);
      await flush();
      h.protocol.handleServerEvent({ type: 'response.created', response: { id: 'resp_say', metadata: { source: 'gambit-say' } } });
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.delta', response_id: 'resp_say', delta: 'чужое' });
      expect(h.progress).toEqual([{ type: 'sent' }]);
    });
  });

  describe('tool calls', () => {
    const hint = makeEvent({ kind: 'hint', text: 'Что сейчас под боем?', bubbleText: 'Что под боем?' });
    const makeHost = (): CoachToolHost => ({
      getPositionSummary: vi.fn(() => Promise.resolve('Ходят белые. Под боем конь.')),
      getHint: vi.fn(() => Promise.resolve(hint)),
      explainLastMove: vi.fn(() => Promise.resolve(null)),
      showOnBoard: vi.fn(),
      takeBackMove: vi.fn(() => true),
    });
    const call = (name: string, args: unknown, callId = 'call_1'): Record<string, unknown> => ({
      type: 'function_call',
      name,
      call_id: callId,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    });

    it('routes function_call → tool host → function_call_output → response.create', async () => {
      const h = setup();
      const host = makeHost();
      h.host.current = host;
      h.protocol.handleServerEvent(created('resp_1', false));
      h.protocol.handleServerEvent(done('resp_1', { output: [call('get_hint', { level: 2 })] }));
      await flush();

      // the model asked for step 2 straight away — the ladder starts at step 1
      expect(host.getHint).toHaveBeenCalledWith(1);
      expect(h.toolEvents).toEqual([hint]);
      // FACTS + the step, for the model to phrase — no ready line to read out
      expect(h.sent).toEqual([
        {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: 'call_1',
            output: JSON.stringify({
              факты: hintFacts(hint, 1),
              ступень_подсказки: 1,
              можно_назвать_ход: false,
              как_отвечать: 'своими словами, одно–два коротких предложения, только по этим фактам; время на часах, цвет фигур и чей ход не пересказывай',
            }),
          },
        },
        { type: 'response.create' },
      ]);
      expect(outputOf(h.sent[0])).not.toMatch(/скажи_ребёнку/);
      expect(h.thinking).toEqual([true]);
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started' });
      expect(h.thinking).toEqual([true, false]);
    });

    it('answers every call of a response and creates one follow-up response', async () => {
      const h = setup();
      h.host.current = makeHost();
      h.protocol.handleServerEvent(
        done('resp_1', { output: [call('get_position_summary', {}, 'a'), { type: 'message' }, call('take_back_move', {}, 'b')] }),
      );
      await flush();
      expect(h.types()).toEqual(['conversation.item.create', 'conversation.item.create', 'response.create']);
      expect(outputOf(h.sent[1])).toBe(JSON.stringify({ ход_возвращён: true }));
    });

    it('wait_for_user answers the call but does not make the model speak', async () => {
      const h = setup();
      h.host.current = makeHost();
      h.protocol.handleServerEvent(done('resp_1', { output: [call('wait_for_user', {})] }));
      await flush();
      expect(h.types()).toEqual(['conversation.item.create']);
      expect(h.thinking).toEqual([true, false]);
    });

    it('show_on_board only passes validated squares to the board', async () => {
      const h = setup();
      const host = makeHost();
      h.host.current = host;
      const args = { arrows: [{ from: 'g1', to: 'f3', color: 'green' }, { from: 'z9', to: 'f3' }, { from: 'e2', to: 'e2' }], highlights: [{ square: 'e4' }, { square: 'nope' }] };
      h.protocol.handleServerEvent(done('resp_1', { output: [call('show_on_board', args)] }));
      await flush();
      expect(host.showOnBoard).toHaveBeenCalledWith({
        arrows: [{ from: 'g1', to: 'f3', color: 'green' }],
        highlights: [{ square: 'e4', color: 'yellow' }],
      });
    });

    it('tells the model (in Russian) when no game is running, a tool is unknown, broken or too slow', async () => {
      const h = setup();
      h.protocol.handleServerEvent(done('r1', { output: [call('get_hint', { level: 1 })] }));
      await flush();
      expect(outputOf(h.sent[0])).toMatch(/партия не идёт/);
      h.sent.length = 0;

      const host = makeHost();
      host.getPositionSummary = () => Promise.reject(new Error('engine crashed'));
      host.getHint = () => new Promise<CoachEvent>(() => undefined);
      h.host.current = host;
      h.sent.length = 0;
      h.protocol.handleServerEvent(done('r2', { output: [call('nope', '{broken json', 'x'), call('analyze_position', {}, 'y'), call('get_hint', {}, 'z')] }));
      await vi.advanceTimersByTimeAsync(6000);
      const outputs = h.sent.filter((e) => e.type === 'conversation.item.create').map(outputOf);
      expect(outputs[0]).toMatch(/инструмента нет/);
      expect(outputs[1]).toMatch(/не работает/);
      expect(outputs[2]).toMatch(/не успел/);
    });

    it('hint ladder: get_hint(level 4) is never honoured directly — one step up per request, a new position starts over', async () => {
      const h = setup();
      const host = makeHost();
      let position = 'Позиция один.';
      host.getPositionSummary = vi.fn(() => Promise.resolve(position));
      host.getHint = vi.fn((level) => Promise.resolve(makeEvent({ kind: 'hint', hintLevel: level, text: `Ступень ${level}` })));
      h.host.current = host;

      const ask = async (level: number, id: string): Promise<void> => {
        h.protocol.handleServerEvent(done(id, { output: [call('get_hint', { level }, id)] }));
        await flush();
      };
      await ask(4, 'a');
      await ask(4, 'b');
      await ask(1, 'c'); // asking for less is always fine
      await ask(4, 'd');
      await ask(4, 'e');
      expect(vi.mocked(host.getHint).mock.calls.map(([level]) => level)).toEqual([1, 2, 1, 3, 4]);

      position = 'Позиция два.';
      await ask(4, 'f');
      expect(vi.mocked(host.getHint).mock.calls.at(-1)).toEqual([1]);
      const outputs = h.sent.filter((e) => e.type === 'conversation.item.create').map((e) => JSON.parse(outputOf(e)) as Record<string, unknown>);
      expect(outputs.at(-1)).toMatchObject({ ступень_подсказки: 1, можно_назвать_ход: false });
      expect(String(outputs.at(-1)?.факты)).toMatch(/Подсказка ступени 1 из четырёх: Ступень 1\. На этой ступени не называй ни ход, ни клетку/);
      // only the fourth step may name the move
      expect(outputs.filter((o) => o.можно_назвать_ход === true).map((o) => o.ступень_подсказки)).toEqual([4]);
    });

    it('analyze_position: analyzePosition when the game has it, the older summary otherwise; the old tool name still works', async () => {
      const h = setup();
      const host = makeHost();
      h.host.current = host;
      h.protocol.handleServerEvent(done('r1', { output: [call('analyze_position', {}, 'a')] }));
      await flush();
      expect(JSON.parse(outputOf(h.sent[0]))).toMatchObject({ факты: 'Ходят белые. Под боем конь.' });

      const rich: CoachToolHost = { ...makeHost(), analyzePosition: vi.fn(() => Promise.resolve('Соперник грозит шахом.')) };
      h.host.current = rich;
      h.sent.length = 0;
      h.protocol.handleServerEvent(done('r2', { output: [call('get_position_summary', {}, 'b')] }));
      await flush();
      expect(rich.analyzePosition).toHaveBeenCalledTimes(1);
      expect(JSON.parse(outputOf(h.sent[0]))).toMatchObject({ факты: 'Соперник грозит шахом.', как_отвечать: expect.stringMatching(/своими словами/) as string });
    });

    it('evaluate_move: SAN / UCI / Russian words are normalised for the host; unclear → ask the child, nothing guessed', async () => {
      const h = setup();
      const evaluateMove = vi.fn((move: string) => Promise.resolve(`факты про ${move}`));
      h.host.current = { ...makeHost(), evaluateMove };
      const ask = async (move: unknown, id: string): Promise<Record<string, unknown>> => {
        h.protocol.handleServerEvent(done(id, { output: [call('evaluate_move', { move }, id)] }));
        await flush();
        return JSON.parse(outputOf(h.sent.filter((e) => e.type === 'conversation.item.create').at(-1))) as Record<string, unknown>;
      };
      expect(await ask('Nxf3', 'a')).toMatchObject({ факты: 'факты про Nf3' }); // a spurious capture sign is dropped
      expect(await ask('g1f3', 'b')).toMatchObject({ факты: 'факты про g1f3' });
      expect(await ask('конь на эф три', 'c')).toMatchObject({ факты: 'факты про Nf3' });
      expect(await ask('exd5', 'd')).toMatchObject({ факты: 'факты про exd5' });
      expect(evaluateMove.mock.calls.map(([move]) => move)).toEqual(['Nf3', 'g1f3', 'Nf3', 'exd5']);
      expect(await ask('конём', 'e')).toEqual({ нужно_уточнить: CLARIFY_MOVE_FACTS_RU });
      expect(await ask(42, 'f')).toEqual({ нужно_уточнить: CLARIFY_MOVE_FACTS_RU });
      expect(evaluateMove).toHaveBeenCalledTimes(4);
    });

    it('compare_move («а почему не ферзём?»): the move or the piece goes to compareMove; an older game falls back to evaluateMove', async () => {
      const h = setup();
      const compareMove = vi.fn((query: { move?: string; piece?: string }) => Promise.resolve(`сравнение ${JSON.stringify(query)}`));
      const evaluateMove = vi.fn((move: string) => Promise.resolve(`факты про ${move}`));
      h.host.current = { ...makeHost(), compareMove, evaluateMove };
      const ask = async (args: unknown, id: string): Promise<Record<string, unknown>> => {
        h.protocol.handleServerEvent(done(id, { output: [call('compare_move', args, id)] }));
        await flush();
        return JSON.parse(outputOf(h.sent.filter((e) => e.type === 'conversation.item.create').at(-1))) as Record<string, unknown>;
      };
      expect(await ask({ piece: 'ферзь' }, 'a')).toMatchObject({ факты: 'сравнение {"piece":"q"}', как_отвечать: expect.stringMatching(/своими словами/) as string });
      expect(await ask({ move: 'Qh5' }, 'b')).toMatchObject({ факты: 'сравнение {"move":"Qh5"}' });
      expect(await ask({ move: 'конь цэ три', piece: 'конь' }, 'c')).toMatchObject({ факты: 'сравнение {"move":"Nc3"}' });
      expect(await ask({}, 'd')).toEqual({ нужно_уточнить: CLARIFY_MOVE_FACTS_RU });
      expect(compareMove.mock.calls.map(([query]) => query)).toEqual([{ piece: 'q' }, { move: 'Qh5' }, { move: 'Nc3' }]);
      expect(evaluateMove).not.toHaveBeenCalled();

      // a game without compareMove: a named move is judged alone, a piece alone makes the model ask where to
      const older = setup();
      older.host.current = { ...makeHost(), evaluateMove };
      older.protocol.handleServerEvent(done('e', { output: [call('compare_move', { move: 'd1h5' }, 'e')] }));
      await flush();
      expect(JSON.parse(outputOf(older.sent[0]))).toMatchObject({ факты: 'факты про d1h5' });
      older.sent.length = 0;
      older.protocol.handleServerEvent(done('f', { output: [call('compare_move', { piece: 'ферзь' }, 'f')] }));
      await flush();
      expect(JSON.parse(outputOf(older.sent[0]))).toEqual({ нужно_уточнить: clarifyPieceMoveFacts('q') });
      expect(clarifyPieceMoveFacts('q')).toMatch(/про ход ферзём/);
      expect(clarifyPieceMoveFacts('q')).not.toMatch(/[A-Za-z]/);
    });

    it('get_hint in teacher mode: the host answers with its advice (teachTurn) — no step caveat, the advised moves may be named', async () => {
      const h = setup();
      const advice = makeEvent({
        kind: 'teachTurn',
        text: 'Смотри: конь на эф три или конь на цэ три.',
        brief: 'Момент: ученик попросил совет ещё раз.\nФакты: Конь выходит в игру.\nМожно назвать: конь на эф три (зелёная стрелка).\nЦель: коротко повтори.\nНельзя: не называй других ходов.',
        teach: { moment: 'repeat', style: 'short', ply: 3, advice: [{ uci: 'g1f3', san: 'Nf3', source: 'mainLine', arrow: 'green' }] },
      });
      h.host.current = { ...makeHost(), getHint: vi.fn(() => Promise.resolve(advice)) };
      h.protocol.handleServerEvent(done('r1', { output: [call('get_hint', { level: 1 })] }));
      await flush();
      expect(h.toolEvents).toEqual([advice]);
      const output = JSON.parse(outputOf(h.sent[0])) as Record<string, unknown>;
      expect(output).toMatchObject({ совет_учителя: true, можно_назвать_ход: true });
      expect(output).not.toHaveProperty('ступень_подсказки');
      expect(String(output.факты)).toMatch(/^Совет учителя/);
      expect(String(output.факты)).toMatch(/Можно назвать: конь на эф три/);
      expect(String(output.факты)).not.toMatch(/На этой ступени не называй/);

      // a «treasure» (the child should find it first): nothing may be named
      const treasure = setup();
      const hidden = { ...advice, id: 'treasure', teach: { moment: 'turn' as const, style: 'full' as const, ply: 5, advice: [], reveal: 'later' as const } };
      treasure.host.current = { ...makeHost(), getHint: vi.fn(() => Promise.resolve(hidden)) };
      treasure.protocol.handleServerEvent(done('r2', { output: [call('get_hint', { level: 1 })] }));
      await flush();
      const hiddenOutput = JSON.parse(outputOf(treasure.sent[0])) as Record<string, unknown>;
      expect(hiddenOutput).toMatchObject({ совет_учителя: true, можно_назвать_ход: false });
      expect(String(hiddenOutput.факты)).toMatch(/не называй: пусть ребёнок найдёт сам/);
    });

    it('explain_last_move returns facts of the explanation (with the bubble/arrows event for the dock)', async () => {
      const h = setup();
      const explanation = makeEvent({ kind: 'explainBest', text: 'Сильнее было увести коня.', brief: 'Ход оставил коня без защиты. Сильнее было его увести.' });
      h.host.current = { ...makeHost(), explainLastMove: vi.fn(() => Promise.resolve(explanation)) };
      h.protocol.handleServerEvent(done('r1', { output: [call('explain_last_move', {}, 'x')] }));
      await flush();
      expect(h.toolEvents).toEqual([explanation]);
      // the brief (facts) is preferred over the template text
      expect(String(JSON.parse(outputOf(h.sent[0])).факты)).toMatch(/^Разбор последнего хода: Ход оставил коня без защиты\./);
    });

    it('sanitizeAnnotations tolerates garbage', () => {
      expect(sanitizeAnnotations(null)).toEqual({ arrows: [], highlights: [] });
      expect(sanitizeAnnotations({ arrows: 'x', highlights: [1, null] })).toEqual({ arrows: [], highlights: [] });
    });
  });

  describe('push-to-talk', () => {
    it('beginUserTurn barges in: cancels the coach and clears the input buffer', async () => {
      const h = setup();
      const spoken = h.protocol.speak('длинная фраза');
      await flush();
      h.protocol.handleServerEvent(created('resp_1'));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started' });
      h.sent.length = 0;

      h.protocol.beginUserTurn();
      expect(h.types()).toEqual(['response.cancel', 'output_audio_buffer.clear', 'input_audio_buffer.clear']);
      expect(await spoken).toBe('interrupted');
    });

    it('endUserTurn commits and asks for an answer; an accidental tap only clears', () => {
      const h = setup();
      h.protocol.endUserTurn(120);
      expect(h.types()).toEqual(['input_audio_buffer.clear']);
      h.sent.length = 0;
      h.protocol.endUserTurn(1800);
      expect(h.types()).toEqual(['input_audio_buffer.commit', 'response.create']);
      expect(h.thinking).toEqual([true]);
    });
  });

  describe('open microphone', () => {
    it("configureSession('open') keeps server VAD: semantic, low eagerness, creates responses, lets the child interrupt", () => {
      const h = setup();
      h.protocol.configureSession('open');
      const update = view<{ session: { tools: unknown[]; audio: { input: { turn_detection: Record<string, unknown> } } } }>(h.sent[0]);
      expect(update.session.tools).toBe(REALTIME_TOOLS);
      expect(update.session.audio.input.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true });
      expect(update.session.audio.input.turn_detection).toBe(OPEN_MIC_TURN_DETECTION);
      expect(h.protocol.micMode).toBe('open');
    });

    it('setMicMode switches turn detection at runtime and sends nothing when the mode is unchanged', () => {
      const h = setup();
      h.protocol.configureSession('open');
      h.sent.length = 0;
      h.protocol.setMicMode('open');
      expect(h.sent).toEqual([]);
      h.protocol.setMicMode('push');
      expect(h.sent).toEqual([{ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: null } } } }]);
      h.protocol.setMicMode('open');
      expect(view<{ session: { audio: { input: { turn_detection: unknown } } } }>(h.sent[1]).session.audio.input.turn_detection).toBe(OPEN_MIC_TURN_DETECTION);
    });

    it('barge-in: the child starts talking while the coach speaks → playback cleared at once, speak() resolves, nothing is repeated', async () => {
      const h = setup();
      h.protocol.configureSession('open');
      const spoken = h.protocol.speak('Длинное объяснение про вилку и связку.');
      await flush();
      h.protocol.handleServerEvent(created('resp_1'));
      h.protocol.handleServerEvent({ type: 'output_audio_buffer.started' });
      h.sent.length = 0;

      h.protocol.handleServerEvent({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1200 });
      expect(h.types()).toEqual(['response.cancel', 'output_audio_buffer.clear']);
      expect(await spoken).toBe('interrupted');
      expect(h.childSpeaking).toEqual([true]);
      expect(h.protocol.childSpeaking).toBe(true);

      // the late response.done of the cancelled phrase changes nothing
      h.protocol.handleServerEvent(done('resp_1', { status: 'cancelled' }));
      h.protocol.handleServerEvent({ type: 'input_audio_buffer.speech_stopped' });
      expect(h.childSpeaking).toEqual([true, false]);
    });

    it('speech_started while the coach is silent only reports that the child talks', () => {
      const h = setup();
      h.protocol.configureSession('open');
      h.sent.length = 0;
      h.protocol.handleServerEvent({ type: 'input_audio_buffer.speech_started' });
      expect(h.sent).toEqual([]);
      expect(h.childSpeaking).toEqual([true]);
    });

    it('push-to-talk ignores VAD events (there is no server VAD)', () => {
      const h = setup();
      h.protocol.configureSession('push');
      h.protocol.handleServerEvent({ type: 'input_audio_buffer.speech_started' });
      expect(h.childSpeaking).toEqual([]);
    });

    it('an app phrase waits up to 1.5 s for the child to finish the sentence', async () => {
      const h = setup();
      h.protocol.configureSession('open');
      h.protocol.handleServerEvent({ type: 'input_audio_buffer.speech_started' });
      h.sent.length = 0;

      void h.protocol.speak('Хороший ход!');
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sent).toEqual([]);
      h.protocol.handleServerEvent({ type: 'input_audio_buffer.speech_stopped' });
      await flush();
      expect(h.types()).toEqual(['conversation.item.create', 'response.create']);
    });

    it('…but never longer than 1.5 s, and an urgent phrase does not wait at all', async () => {
      const h = setup();
      h.protocol.configureSession('open');
      h.protocol.handleServerEvent({ type: 'input_audio_buffer.speech_started' });
      h.sent.length = 0;

      void h.protocol.speak('Обычная фраза.');
      await vi.advanceTimersByTimeAsync(1400);
      expect(h.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.types()).toEqual(['conversation.item.create', 'response.create']);

      const other = setup();
      other.protocol.configureSession('open');
      other.protocol.handleServerEvent({ type: 'input_audio_buffer.speech_started' });
      other.sent.length = 0;
      void other.protocol.speak('Стоп-стоп! Давай вернём ход.', { interrupt: true });
      await flush();
      expect(other.types()).toEqual(['conversation.item.create', 'response.create']);
    });

    it('pushContext adds a silent system note and never asks for a response', () => {
      const h = setup();
      h.protocol.pushContext('  Ход 12: ученик сыграл слон эф четыре.\n Угроз нет. ');
      h.protocol.pushContext('   ');
      expect(h.sent).toEqual([
        {
          type: 'conversation.item.create',
          item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: buildContextNote('Ход 12: ученик сыграл слон эф четыре. Угроз нет.') }] },
        },
      ]);
      expect(buildContextNote('x')).toMatch(/вслух не произноси/);
    });
  });

  describe('transcripts', () => {
    it('reports what the child said and what the coach answered on its own', () => {
      const h = setup();
      h.protocol.handleServerEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' а почему конь? ' });
      h.protocol.handleServerEvent(created('resp_model', false));
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.delta', response_id: 'resp_model', delta: 'Потому ' });
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.delta', response_id: 'resp_model', delta: 'что…' });
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.done', response_id: 'resp_model', transcript: 'Потому что он прыгает!' });
      expect(h.transcripts).toEqual(['child: а почему конь?', 'coach: Потому что он прыгает!']);
      expect(h.captions).toEqual(['Потому ', 'Потому что…', 'Потому что он прыгает!']);
    });

    it('does not echo verbatim speak() phrases back as coach answers', async () => {
      const h = setup();
      void h.protocol.speak('Ход конём!');
      await flush();
      h.protocol.handleServerEvent(created('resp_say'));
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.delta', response_id: 'resp_say', delta: 'Ход' });
      h.protocol.handleServerEvent({ type: 'response.output_audio_transcript.done', response_id: 'resp_say', transcript: 'Ход конём!' });
      expect(h.transcripts).toEqual([]);
      expect(h.captions).toEqual([]);
    });
  });

  it('ignores malformed server events', () => {
    const h = setup();
    expect(() => {
      h.protocol.handleServerEvent(null);
      h.protocol.handleServerEvent('text');
      h.protocol.handleServerEvent({ nope: true });
      h.protocol.handleServerEvent({ type: 'response.done' });
      h.protocol.handleServerEvent({ type: 'some.future.event' });
    }).not.toThrow();
  });
});
