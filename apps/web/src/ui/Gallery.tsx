/**
 * Dev harness: every primitive of the design system on one page, plus all persona avatars.
 * Open `/src/ui/gallery.html` on the Vite dev server, or mount <Gallery /> from the shell.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { PERSONA_IDS } from '@gambit/shared';
import type { AnnotationColor, Persona } from '@gambit/shared';
import { Badge } from './Badge.tsx';
import { BigChoice } from './BigChoice.tsx';
import { BOARD_THEMES, ARROW_COLORS, boardThemeStyles, buildSquareStyles } from './boardTheme.ts';
import type { BoardThemeId } from './boardTheme.ts';
import { Button } from './Button.tsx';
import type { ButtonSize, ButtonVariant } from './Button.tsx';
import { Card } from './Card.tsx';
import { celebrate } from './confetti.ts';
import type { CelebrationKind } from './confetti.ts';
import styles from './Gallery.module.css';
import { Icon, ICON_NAMES } from './icons.tsx';
import { Modal } from './Modal.tsx';
import { PersonaAvatar } from './PersonaAvatar.tsx';
import type { PersonaMood } from './PersonaAvatar.tsx';
import { ProgressBar } from './ProgressBar.tsx';
import { SAMPLE_PERSONAS } from './samplePersonas.ts';
import { Screen } from './Screen.tsx';
import { SOUND_NAMES, isSoundMuted, playSound, toggleSoundMuted } from './sounds.ts';
import { Spinner } from './Spinner.tsx';
import { Stars } from './Stars.tsx';

const SWATCHES: { name: string; token: string; dark?: boolean }[] = [
  { name: 'Бумага', token: '--color-bg' },
  { name: 'Карточка', token: '--color-surface' },
  { name: 'Тёплый фон', token: '--color-surface-2' },
  { name: 'Чернила', token: '--color-ink', dark: true },
  { name: 'Бирюза', token: '--color-primary', dark: true },
  { name: 'Глубокая бирюза', token: '--color-primary-deep', dark: true },
  { name: 'Солнце', token: '--color-sunny' },
  { name: 'Звезда', token: '--color-star' },
  { name: 'Коралл', token: '--color-coral' },
  { name: 'Успех', token: '--color-success' },
  { name: 'Небо', token: '--color-info' },
  { name: 'Клетка светлая', token: '--board-light' },
  { name: 'Клетка тёмная', token: '--board-dark' },
];

const TYPE_STEPS = ['--text-3xl', '--text-2xl', '--text-xl', '--text-lg', '--text-md', '--text-sm'] as const;
const BUTTON_VARIANTS: ButtonVariant[] = ['primary', 'accent', 'secondary', 'ghost', 'danger'];
const BUTTON_SIZES: ButtonSize[] = ['md', 'lg', 'xl'];
const BUTTON_LABELS: Record<ButtonVariant, string> = { primary: 'Играть', accent: 'Подсказка', secondary: 'Вернуть ход', ghost: 'Позже', danger: 'Сдаться' };
const MOODS: PersonaMood[] = ['neutral', 'happy', 'sad'];
const HAIR_STYLES: Persona['avatar']['hairStyle'][] = ['short', 'curly', 'ponytail', 'bob', 'cap', 'spiky', 'long', 'bun'];
const ACCESSORIES: (Persona['avatar']['accessory'] | undefined)[] = [undefined, 'glasses', 'headphones', 'bow', 'cap', 'scarf'];
const ANNOTATION_COLORS: AnnotationColor[] = ['green', 'red', 'yellow', 'blue'];
const SOUND_LABELS: Record<(typeof SOUND_NAMES)[number], string> = {
  move: 'Ход',
  capture: 'Взятие',
  check: 'Шах',
  win: 'Победа',
  lose: 'Поражение',
  click: 'Клик',
  oops: 'Упс',
  star: 'Звезда',
};

function isPersona(value: unknown): value is Persona {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const avatar = v.avatar as Record<string, unknown> | undefined;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.age === 'number' && typeof avatar === 'object' && avatar !== null && typeof avatar.hairStyle === 'string';
}

/** Loads PERSONAS from @gambit/content when that package already exports them; otherwise keeps the sample list. */
function usePersonas(): { personas: Persona[]; source: 'content' | 'sample' } {
  const [state, setState] = useState<{ personas: Persona[]; source: 'content' | 'sample' }>({ personas: SAMPLE_PERSONAS, source: 'sample' });
  useEffect(() => {
    let alive = true;
    import('@gambit/content')
      .then((mod: unknown) => {
        const record = (mod as { PERSONAS?: unknown }).PERSONAS;
        if (!alive || typeof record !== 'object' || record === null) return;
        const byId = record as Record<string, unknown>;
        const list = PERSONA_IDS.map((id) => byId[id]).filter(isPersona);
        if (list.length === PERSONA_IDS.length) setState({ personas: list, source: 'content' });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

function StrengthPawns({ level }: { level: number }) {
  return (
    <span className={styles.pawns} role="img" aria-label={`Сила: ${level} из 8`}>
      {PERSONA_IDS.map((id, i) => (
        <span key={id} className={styles.pawn} data-on={i < level || undefined}>
          <Icon name="pawn" />
        </span>
      ))}
    </span>
  );
}

function MiniBoard({ themeId }: { themeId: BoardThemeId }) {
  const theme = BOARD_THEMES[themeId];
  const themeStyles = boardThemeStyles(theme);
  const marks = buildSquareStyles({
    lastMove: { from: 'e2', to: 'e4' },
    selected: 'g1',
    legalTargets: [
      { square: 'f3', capture: false },
      { square: 'h3', capture: false },
      { square: 'e5', capture: true },
    ],
    checkSquare: 'e8',
    ringPx: 3,
    annotations: {
      highlights: [
        { square: 'b5', color: 'green' },
        { square: 'c6', color: 'red' },
        { square: 'b3', color: 'yellow' },
        { square: 'c2', color: 'blue' },
      ],
    },
  });
  const squares: { id: string; style: CSSProperties }[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    for (let file = 0; file < 8; file++) {
      const id = `${'abcdefgh'[file]}${rank}`;
      const isLight = (file + rank) % 2 === 0;
      squares.push({ id, style: { ...(isLight ? themeStyles.lightSquareStyle : themeStyles.darkSquareStyle) } });
    }
  }
  return (
    <figure className={styles.boardFigure}>
      <div className={styles.miniBoard} style={themeStyles.boardStyle}>
        {squares.map((sq) => (
          <div key={sq.id} style={sq.style} className={styles.miniSquare}>
            <div className={styles.miniMark} style={marks[sq.id]} />
          </div>
        ))}
      </div>
      <figcaption>{theme.nameRu}</figcaption>
    </figure>
  );
}

export interface GalleryProps {
  onBack?: () => void;
}

export function Gallery({ onBack }: GalleryProps) {
  const { personas, source } = usePersonas();
  const [choice, setChoice] = useState('rapid10');
  const [opponent, setOpponent] = useState<string>('sasha');
  const [modal, setModal] = useState<'none' | 'info' | 'decision'>('none');
  const [muted, setMuted] = useState(isSoundMuted());
  const [stars, setStars] = useState(2);
  const [progress, setProgress] = useState(37);
  const [confettiNote, setConfettiNote] = useState('');

  const fire = (kind: CelebrationKind) => {
    void celebrate(kind).then((shown) => setConfettiNote(shown ? '' : 'Анимация выключена — вместо конфетти покажем звезду ⭐'));
  };

  return (
    <Screen
      title="Витрина"
      subtitle="Все детали интерфейса «Гамбитика»"
      onBack={onBack}
      actions={
        <Button
          variant="secondary"
          icon={<Icon name={muted ? 'soundOff' : 'sound'} />}
          aria-label={muted ? 'Включить звуки' : 'Выключить звуки'}
          aria-pressed={muted}
          onClick={() => setMuted(toggleSoundMuted())}
        />
      }
    >
      <div className={styles.stack}>
        <section className={styles.section} aria-labelledby="g-palette">
          <h2 id="g-palette">Цвета</h2>
          <ul className={styles.swatches}>
            {SWATCHES.map((s) => (
              <li key={s.token} className={styles.swatch} data-dark={s.dark || undefined} style={{ background: `var(${s.token})` }}>
                <span>{s.name}</span>
                <code>{s.token}</code>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="g-type">
          <h2 id="g-type">Шрифт</h2>
          <Card>
            <div className={styles.typeScale}>
              {TYPE_STEPS.map((step) => (
                <p key={step} style={{ fontSize: `var(${step})`, fontWeight: step === '--text-md' || step === '--text-sm' ? 650 : 900, lineHeight: 1.15 }}>
                  Ход конём! <span className={styles.muted}>{step}</span>
                </p>
              ))}
            </div>
          </Card>
        </section>

        <section className={styles.section} aria-labelledby="g-buttons">
          <h2 id="g-buttons">Кнопки</h2>
          <Card>
            <div className={styles.buttonGrid}>
              {BUTTON_SIZES.map((size) => (
                <div key={size} className={styles.row}>
                  {BUTTON_VARIANTS.map((variant) => (
                    <Button key={variant} variant={variant} size={size} icon={variant === 'accent' ? <Icon name="bulb" /> : variant === 'secondary' ? <Icon name="undo" /> : variant === 'danger' ? <Icon name="flag" /> : undefined}>
                      {BUTTON_LABELS[variant]}
                    </Button>
                  ))}
                </div>
              ))}
              <div className={styles.row}>
                <Button disabled>Недоступно</Button>
                <Button loading>Думаю</Button>
                <Button variant="secondary" icon={<Icon name="gear" />} aria-label="Настройки" />
                <Button variant="accent" size="lg" icon={<Icon name="mic" />} aria-label="Гамбитик, слушай" />
                <Button variant="primary" size="lg" iconAfter={<Icon name="forward" />}>
                  Дальше
                </Button>
              </div>
              <div className={styles.iconRow}>
                {ICON_NAMES.map((name) => (
                  <span key={name} className={styles.iconCell} title={name}>
                    <Icon name={name} size={28} />
                  </span>
                ))}
              </div>
            </div>
          </Card>
        </section>

        <section className={styles.section} aria-labelledby="g-choice">
          <h2 id="g-choice">Большие плитки</h2>
          <div className={styles.homeTiles}>
            <BigChoice layout="column" accent="sunny" icon="♞" title="Играть" subtitle="Партия с другом-ботом" />
            <BigChoice layout="column" accent="green" icon="🧩" title="Задачки" subtitle="Три штуки для разминки" badge={<Badge tone="sunny" variant="solid">Сегодня ещё не было</Badge>} />
            <BigChoice layout="column" accent="blue" icon="🗺️" title="Путь пешки" subtitle="Моя дорога к ферзю" />
          </div>
          <div className={styles.rowTiles}>
            <BigChoice icon="🚀" accent="coral" title="1 минута" subtitle="Молния: я молчу, некогда!" selected={choice === 'bullet1'} onClick={() => setChoice('bullet1')} />
            <BigChoice icon="⚡" accent="sunny" title="5 минут" subtitle="Блиц: подскажу разок" selected={choice === 'blitz5'} onClick={() => setChoice('blitz5')} />
            <BigChoice
              icon="🐢"
              accent="green"
              title="10 минут"
              subtitle="Спокойная: помогу подумать"
              selected={choice === 'rapid10'}
              onClick={() => setChoice('rapid10')}
              badge={<Badge tone="teal" variant="solid" icon={<Icon name="star" />}>Гамбитик советует</Badge>}
            />
            <BigChoice icon="🔒" title="Турнир" subtitle="Откроется на пятой ступеньке" disabled />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="g-personas">
          <h2 id="g-personas">
            Соперники <Badge tone={source === 'content' ? 'green' : 'neutral'}>{source === 'content' ? 'из @gambit/content' : 'пример'}</Badge>
          </h2>
          <div className={styles.personaGrid}>
            {personas.map((p, i) => (
              <BigChoice
                key={p.id}
                layout="column"
                icon={<PersonaAvatar persona={p} size={128} label="" mood={opponent === p.id ? 'happy' : 'neutral'} />}
                title={p.name}
                subtitle={`${p.age} лет · ${p.tagline}`}
                selected={opponent === p.id}
                onClick={() => setOpponent(p.id)}
                className={styles.personaTile}
              >
                <StrengthPawns level={i + 1} />
              </BigChoice>
            ))}
          </div>
          <Card title="Настроения и размеры" flat>
            <div className={styles.moodGrid}>
              {personas.map((p) => (
                <div key={p.id} className={styles.moodRow}>
                  {MOODS.map((mood) => (
                    <PersonaAvatar key={mood} persona={p} mood={mood} size={72} />
                  ))}
                  <PersonaAvatar persona={p} size={48} />
                  <PersonaAvatar persona={p} size={32} />
                </div>
              ))}
            </div>
          </Card>
          <Card title="Причёски и аксессуары" flat>
            <div className={styles.matrix}>
              {HAIR_STYLES.map((hairStyle, row) =>
                ACCESSORIES.map((accessory, col) => {
                  const base = SAMPLE_PERSONAS[(row + col) % SAMPLE_PERSONAS.length] as Persona;
                  const persona: Persona = { ...base, avatar: { ...base.avatar, hairStyle, accessory } };
                  return <PersonaAvatar key={`${hairStyle}-${accessory ?? 'none'}`} persona={persona} size={64} label={`${hairStyle}, ${accessory ?? 'без аксессуара'}`} />;
                }),
              )}
            </div>
          </Card>
        </section>

        <section className={styles.section} aria-labelledby="g-feedback">
          <h2 id="g-feedback">Награды и прогресс</h2>
          <div className={styles.twoCols}>
            <Card title="Звёзды за старание" headerAside={<Badge tone="sunny">за усилие</Badge>}>
              <div className={styles.column}>
                <Stars key={stars} value={stars} max={3} size={56} animate />
                <div className={styles.row}>
                  <Stars value={0} />
                  <Stars value={1.5} />
                  <Stars value={5} max={5} size={24} />
                </div>
                <div className={styles.row}>
                  <Button variant="secondary" onClick={() => setStars((s) => (s + 1) % 4)}>
                    Ещё звезда
                  </Button>
                </div>
              </div>
            </Card>
            <Card title="Прогресс">
              <div className={styles.column}>
                <ProgressBar value={progress} label="Путь пешки" valueText={`${Math.round(progress / 12.5)} из 8`} size="lg" tone="sunny" />
                <ProgressBar value={7} max={10} label="Вилки" valueText="7 из 10" tone="green" />
                <ProgressBar value={0} label="Связки" valueText />
                <ProgressBar value={64} aria-label="Точность" size="sm" />
                <div className={styles.row}>
                  <Button variant="secondary" onClick={() => setProgress((v) => (v >= 100 ? 0 : Math.min(100, v + 21)))}>
                    Шаг вперёд
                  </Button>
                  <Spinner />
                  <Spinner size={32} label="Гамбитик думает…" showLabel />
                </div>
              </div>
            </Card>
          </div>
          <div className={styles.row}>
            {(['teal', 'sunny', 'coral', 'green', 'blue', 'neutral'] as const).map((tone) => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ))}
            {(['teal', 'sunny', 'coral', 'green', 'blue', 'neutral'] as const).map((tone) => (
              <Badge key={tone} tone={tone} variant="solid" icon={<Icon name="star" />}>
                {tone}
              </Badge>
            ))}
          </div>
          <div className={styles.threeCols}>
            {(['surface', 'tint', 'teal', 'sunny', 'coral', 'green', 'blue'] as const).map((tone) => (
              <Card key={tone} tone={tone} title={`Карточка ${tone}`} padding="sm">
                <p>Короткий тёплый текст для ребёнка.</p>
              </Card>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="g-modal">
          <h2 id="g-modal">Окна, звуки, конфетти</h2>
          <Card>
            <div className={styles.column}>
              <div className={styles.row}>
                <Button variant="secondary" onClick={() => setModal('info')}>
                  Окно с крестиком
                </Button>
                <Button variant="danger" icon={<Icon name="flag" />} onClick={() => setModal('decision')}>
                  Окно-вопрос
                </Button>
              </div>
              <div className={styles.row}>
                {SOUND_NAMES.map((name) => (
                  <Button key={name} variant="secondary" sound={false} icon={<Icon name="play" />} onClick={() => playSound(name)}>
                    {SOUND_LABELS[name]}
                  </Button>
                ))}
              </div>
              <div className={styles.row}>
                <Button variant="accent" onClick={() => fire('win')}>
                  Конфетти: победа
                </Button>
                <Button variant="accent" onClick={() => fire('star')}>
                  Конфетти: звезда
                </Button>
                <Button variant="accent" onClick={() => fire('stage')}>
                  Конфетти: ступенька
                </Button>
                <span aria-live="polite">{confettiNote}</span>
              </div>
            </div>
          </Card>
        </section>

        <section className={styles.section} aria-labelledby="g-board">
          <h2 id="g-board">Доска</h2>
          <div className={styles.boards}>
            {(Object.keys(BOARD_THEMES) as BoardThemeId[]).map((id) => (
              <MiniBoard key={id} themeId={id} />
            ))}
          </div>
          <div className={styles.row}>
            {ANNOTATION_COLORS.map((color) => (
              <span key={color} className={styles.arrowChip}>
                <svg width="72" height="24" viewBox="0 0 72 24" aria-hidden="true">
                  <path d="M4 12h48" stroke={ARROW_COLORS[color]} strokeWidth="9" strokeLinecap="round" />
                  <path d="M50 2l18 10-18 10z" fill={ARROW_COLORS[color]} />
                </svg>
                {color}
              </span>
            ))}
          </div>
        </section>
      </div>

      <Modal open={modal === 'info'} onClose={() => setModal('none')} title="Ты решил три задачки!" icon={<Stars value={3} size={48} animate />} actions={<Button onClick={() => setModal('none')}>Здорово!</Button>}>
        <p>Гамбитик гордится: ты думал над каждым ходом.</p>
      </Modal>
      <Modal
        open={modal === 'decision'}
        onClose={() => setModal('none')}
        dismissible={false}
        title="Точно сдаёшься?"
        icon="🏳️"
        actions={
          <>
            <Button variant="primary" size="lg" onClick={() => setModal('none')}>
              Играю дальше
            </Button>
            <Button variant="secondary" size="lg" onClick={() => setModal('none')}>
              Да, сдаюсь
            </Button>
          </>
        }
      >
        <p>Можно ещё побороться — в шахматах бывает всякое.</p>
      </Modal>
    </Screen>
  );
}
