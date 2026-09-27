/**
 * New-game wizard: time control → opponent → colour. Every step is one tap on a big tile;
 * the third tap starts the game. Nothing is locked — all eight bots are always available,
 * the ones that fit the child's curriculum stage are only highlighted. Step 3 also asks
 * «Как помогает Гамбитик?» (Учитель / Подсказчик / Экзамен) with the right tile already chosen,
 * so the colour tap alone still starts the game.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { PERSONA_ORDER, PERSONAS } from '@gambit/content';
import type { CoachStyle, Persona, PersonaId, StudentProfile, TimeControlId } from '@gambit/shared';
import { coach, useCoachStore } from '../coach/index.ts';
import { watchHello } from '../features/game/hello.ts';
import { prefetchStrategyFor } from '../features/game/strategy.ts';
import { Badge, BigChoice, Icon, PersonaAvatar, Screen, pluralRu } from '../ui/index.ts';
import { shellCoachEvent } from './greeting.ts';
import styles from './NewGame.module.css';
import {
  BULLET_COACH_NOTE,
  TIME_CONTROL_CARDS,
  WIZARD_TITLES,
  coachStyleChoiceAvailable,
  coachStylePhrase,
  coachStyleTile,
  coachStyleTiles,
  createStepGuard,
  initialCoachStyle,
  isStretchOpponent,
  personaRung,
  playRouteFor,
  previousStep,
  recommendedPersonaIds,
  rememberCoachStyle,
  stretchOpponentPhrase,
  timeStepPhrase,
} from './newGame.ts';
import type { ColorChoice, WizardStep } from './newGame.ts';
import type { PlayRoute } from './router.ts';
import { getBrowserStorage } from './shellSettings.ts';
import { useMediaQuery } from './useMediaQuery.ts';

// Was the shell's «Привет» really heard? The wizard's own taps stop the coach and often cut it off; the game asks the
// watch before its first line and greets itself when no hello was heard (features/game/hello.ts). Armed here because
// this module loads with the shell — the watch must see the greeting from the app's very start.
watchHello(useCoachStore);

export interface NewGameProps {
  profile: StudentProfile;
  onStart: (route: PlayRoute) => void;
  onExit: () => void;
}

export interface CoachStylePickerProps {
  timeControlId: TimeControlId;
  value: CoachStyle;
  onChange: (style: CoachStyle) => void;
}

/**
 * «Как помогает Гамбитик?» — 2–3 big pressed-or-not tiles (the same pattern as the parent settings), one of them
 * always chosen; a line under them says what the chosen one means. Bullet shows `BULLET_COACH_NOTE` instead: he only
 * greets there, and «Учитель» is in 5, 10 minutes and «Без часов».
 */
export function CoachStylePicker({ timeControlId, value, onChange }: CoachStylePickerProps) {
  const labelId = useId();
  const tiles = coachStyleTiles(timeControlId);
  if (tiles.length === 0) return <p className={styles.examNote}>{BULLET_COACH_NOTE}</p>;
  const chosen = tiles.find((tile) => tile.style === value) ?? coachStyleTile(value);
  return (
    <div className={styles.styleStep}>
      <h2 id={labelId} className={styles.styleLabel}>
        Как помогает Гамбитик?
      </h2>
      <div className={styles.styleGrid} role="group" aria-labelledby={labelId} data-count={tiles.length}>
        {tiles.map((tile) => (
          <BigChoice
            key={tile.style}
            className={styles.styleTile}
            accent={tile.accent}
            icon={tile.icon}
            title={tile.title}
            subtitle={<span className={styles.styleSubtitle}>{tile.subtitle}</span>}
            selected={tile.style === value}
            onClick={() => onChange(tile.style)}
          />
        ))}
      </div>
      <p className={styles.styleHint} aria-live="polite">
        {chosen.hint}
      </p>
    </div>
  );
}

const LADDER_SIZE = PERSONA_ORDER.length;

function StrengthDots({ rung, elo }: { rung: number; elo: number }) {
  return (
    <span className={styles.strength}>
      <span className={styles.dots} role="img" aria-label={`Сила: ${rung} из ${LADDER_SIZE}`}>
        {Array.from({ length: LADDER_SIZE }, (_, index) => (
          <i key={index} data-on={index < rung ? 'true' : 'false'} />
        ))}
      </span>
      {/* the number is for parents and older kids; the dots are the real scale */}
      <span className={styles.elo} aria-hidden="true">
        ≈ {elo}
      </span>
    </span>
  );
}

function ageRu(age: number): string {
  return `${age} ${pluralRu(age, 'год', 'года', 'лет')}`;
}

const COLOR_TILES: readonly { id: ColorChoice; title: string; subtitle: string }[] = [
  { id: 'w', title: 'Белые', subtitle: 'Твой ход первый' },
  { id: 'b', title: 'Чёрные', subtitle: 'Начинает соперник' },
  { id: 'random', title: 'Сюрприз', subtitle: 'Пусть решит случай' },
];

export function NewGame({ profile, onStart, onExit }: NewGameProps) {
  const [step, setStep] = useState<WizardStep>('time');
  const [timeControlId, setTimeControlId] = useState<TimeControlId | null>(null);
  const [personaId, setPersonaId] = useState<PersonaId | null>(null);
  // preselected when the time control is picked: the remembered choice for it, else the stage default (§1.2)
  const [coachStyle, setCoachStyle] = useState<CoachStyle>('helper');

  // eight portraits in two rows on a laptop; a two-column list on narrow windows
  const wide = useMediaQuery('(min-width: 1100px)');
  // between 1100 and 1279 px the four columns are narrow (the mascot strip takes 320 px): a smaller portrait keeps
  // both rows of bots above the fold of an 820 px high window
  const roomy = useMediaQuery('(min-width: 1280px)');

  const recommended = recommendedPersonaIds(profile.stage);
  const persona: Persona | null = personaId === null ? null : PERSONAS[personaId];
  const timeCard = TIME_CONTROL_CARDS.find((card) => card.control.id === timeControlId) ?? null;

  // Spoken guidance is the interface for a non-reader: a normal phrase (queued behind the greeting, never dropped),
  // and at most one per step — see newGame.ts.
  const spoken = useRef(createStepGuard());
  useEffect(() => {
    if (spoken.current.claim('time')) void coach.say(shellCoachEvent(timeStepPhrase()));
  }, []);

  const back = (): void => {
    const previous = previousStep(step);
    if (previous === null) onExit();
    else setStep(previous);
  };

  const pickTime = (id: TimeControlId): void => {
    setTimeControlId(id);
    // a new time control → its own remembered choice or default (going back and picking another one re-reads it)
    setCoachStyle(initialCoachStyle(id, profile.stage, getBrowserStorage(), Date.now()));
    setStep('opponent');
    // the chatter about time controls is stale now — free the corner for the opponents
    coach.stopSpeaking({ clearBubble: true });
  };

  const pickPersona = (id: PersonaId): void => {
    setPersonaId(id);
    setStep('color');
    if (isStretchOpponent(id, profile.stage) && spoken.current.claim('opponent')) {
      // whatever he was still saying about the time controls is stale now
      coach.stopSpeaking({ clearBubble: true });
      void coach.say(shellCoachEvent(stretchOpponentPhrase(PERSONAS[id].name)));
    }
    // step 3 asks how he should help — said once per wizard, queued behind the stretch phrase if there was one
    const phrase = timeControlId === null ? null : coachStylePhrase(timeControlId, profile.address);
    if (phrase !== null && spoken.current.claim('color')) void coach.say(shellCoachEvent(phrase));
  };

  const pickColor = (color: ColorChoice): void => {
    if (timeControlId === null || personaId === null) {
      setStep('time');
      return;
    }
    // wizard chatter must not talk over the game's own opening phrase
    coach.stopSpeaking({ clearBubble: true });
    const route = playRouteFor({ timeControlId, personaId, color, coachStyle, stage: profile.stage });
    // the next game with this clock starts from the same choice (only offered styles are kept; bullet has none;
    // the stage default is remembered as «follow the default», see rememberCoachStyle)
    rememberCoachStyle(getBrowserStorage(), timeControlId, route.coachStyle, Date.now(), profile.stage);
    // «Учитель»: colour, opponent and time control are known — the smart strategist starts thinking NOW, while the
    // board opens (White; Black asks after the bot's real first move)
    prefetchStrategyFor({ coachStyle: route.coachStyle, childColor: route.childColor, personaId, timeControlId, stage: profile.stage });
    onStart(route);
  };

  const { title, subtitle } = WIZARD_TITLES[step];
  const withStyles = timeControlId !== null && coachStyleChoiceAvailable(timeControlId);

  return (
    <Screen title={title} subtitle={subtitle} onBack={back} backLabel={step === 'time' ? 'Домой' : 'Назад'}>
      {step === 'time' ? (
        <div className={styles.timeGrid}>
          {TIME_CONTROL_CARDS.map((card) => (
            <BigChoice
              key={card.control.id}
              icon={card.icon}
              accent={card.accent}
              title={card.title}
              subtitle={card.subtitle}
              selected={timeControlId === card.control.id ? true : undefined}
              badge={
                card.badge ? (
                  <Badge tone={card.badge.tone} variant="solid" size="sm" icon={card.badge.tone === 'teal' ? <Icon name="star" /> : undefined}>
                    {card.badge.text}
                  </Badge>
                ) : undefined
              }
              onClick={() => pickTime(card.control.id)}
            />
          ))}
        </div>
      ) : null}

      {step === 'opponent' ? (
        <div className={styles.personaGrid}>
          {PERSONA_ORDER.map((id) => {
            const p = PERSONAS[id];
            const fits = recommended.includes(id);
            return (
              <BigChoice
                key={id}
                className={styles.personaTile}
                layout={wide ? 'column' : 'row'}
                icon={<PersonaAvatar persona={p} size={roomy ? 96 : wide ? 76 : 64} label="" mood={fits ? 'happy' : 'neutral'} />}
                title={<span className={styles.personaName}>{`${p.name}, ${ageRu(p.age)}`}</span>}
                subtitle={p.tagline}
                selected={personaId === id ? true : undefined}
                badge={
                  fits ? (
                    <Badge tone="teal" variant="solid" size="sm" icon={<Icon name="star" />}>
                      В самый раз
                    </Badge>
                  ) : undefined
                }
                onClick={() => pickPersona(id)}
              >
                <StrengthDots rung={personaRung(id)} elo={p.nominalElo} />
              </BigChoice>
            );
          })}
        </div>
      ) : null}

      {step === 'color' ? (
        <div className={styles.colorStep}>
          <p className={styles.summary}>
            {persona ? (
              <span className={styles.chip}>
                <PersonaAvatar persona={persona} size={40} label="" /> {persona.name}
              </span>
            ) : null}
            {timeCard ? (
              <span className={styles.chip}>
                <span aria-hidden="true">{timeCard.icon}</span> {timeCard.title}
              </span>
            ) : null}
          </p>

          {timeControlId !== null ? <CoachStylePicker timeControlId={timeControlId} value={coachStyle} onChange={setCoachStyle} /> : null}

          <div className={styles.colorPart}>
            {/* the colour tap starts the game: say so, since another choice sits above it */}
            <h2 className={styles.colorLabel}>Выбери цвет — и начинаем!</h2>
            {/* compact tiles under the style choice, so the start buttons stay above the fold of a 690 px window */}
            <div className={styles.colorGrid} data-compact={withStyles ? 'true' : undefined}>
              {COLOR_TILES.map((tile) => (
                <BigChoice
                  key={tile.id}
                  className={styles.colorTile}
                  layout="column"
                  accent={tile.id === 'random' ? 'sunny' : 'teal'}
                  icon={tile.id === 'random' ? '🎲' : <span className={styles.disc} data-color={tile.id} />}
                  title={tile.title}
                  subtitle={tile.subtitle}
                  onClick={() => pickColor(tile.id)}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </Screen>
  );
}
