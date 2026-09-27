import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PERSONA_IDS } from '@gambit/shared';
import type { Persona } from '@gambit/shared';
import { Badge } from './Badge.tsx';
import { BigChoice } from './BigChoice.tsx';
import { Button } from './Button.tsx';
import { Card } from './Card.tsx';
import { Icon, ICON_NAMES } from './icons.tsx';
import { Modal } from './Modal.tsx';
import { PersonaAvatar } from './PersonaAvatar.tsx';
import { ProgressBar } from './ProgressBar.tsx';
import { SAMPLE_PERSONAS } from './samplePersonas.ts';
import { Screen } from './Screen.tsx';
import { Spinner } from './Spinner.tsx';
import { Stars, starsLabelRu } from './Stars.tsx';

const HAIR_STYLES: Persona['avatar']['hairStyle'][] = ['short', 'curly', 'ponytail', 'bob', 'cap', 'spiky', 'long', 'bun'];
const ACCESSORIES: NonNullable<Persona['avatar']['accessory']>[] = ['glasses', 'headphones', 'bow', 'cap', 'scarf'];

describe('Button', () => {
  it('is a real <button type="button"> by default', () => {
    const html = renderToStaticMarkup(<Button>Играть</Button>);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('type="button"');
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain('data-size="md"');
    expect(html).toContain('Играть');
  });

  it('supports every variant and size, icons and the busy state', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'accent'] as const) {
      for (const size of ['md', 'lg', 'xl'] as const) {
        const html = renderToStaticMarkup(
          <Button variant={variant} size={size} icon={<Icon name="bulb" />}>
            Подсказка
          </Button>,
        );
        expect(html).toContain(`data-variant="${variant}"`);
        expect(html).toContain(`data-size="${size}"`);
        expect(html).toContain('aria-hidden="true"');
      }
    }
    expect(renderToStaticMarkup(<Button loading>Думаю</Button>)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<Button disabled>Нет</Button>)).toContain('disabled=""');
  });

  it('keeps the Russian aria-label on icon-only buttons', () => {
    const html = renderToStaticMarkup(<Button icon={<Icon name="gear" />} aria-label="Настройки" />);
    expect(html).toContain('aria-label="Настройки"');
  });
});

describe('Screen', () => {
  it('renders the title as h1 and a big back button only when onBack is given', () => {
    const withBack = renderToStaticMarkup(
      <Screen title="Соперник" onBack={() => undefined} actions={<Badge>1</Badge>}>
        <p>контент</p>
      </Screen>,
    );
    expect(withBack).toContain('<h1');
    expect(withBack).toContain('Соперник');
    expect(withBack).toContain('Назад');
    expect(withBack).toContain('data-dock="side"');
    expect(withBack).toContain('<main');
    const noBack = renderToStaticMarkup(<Screen title="Дом" dock="none" />);
    expect(noBack).not.toContain('Назад');
    expect(noBack).toContain('data-dock="none"');
  });
});

describe('BigChoice', () => {
  it('is a button that exposes its selected state and badge', () => {
    const html = renderToStaticMarkup(<BigChoice title="10 минут" subtitle="Спокойная" icon="🐢" selected badge={<Badge>Гамбитик советует</Badge>} />);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('10 минут');
    expect(html).toContain('Спокойная');
    expect(html).toContain('Гамбитик советует');
  });

  it('omits aria-pressed for plain navigation tiles and supports disabled', () => {
    const html = renderToStaticMarkup(<BigChoice title="Играть" disabled />);
    expect(html).not.toContain('aria-pressed');
    expect(html).toContain('disabled=""');
  });
});

describe('PersonaAvatar', () => {
  it('draws a distinct labelled face for each of the 8 personas', () => {
    expect(SAMPLE_PERSONAS.map((p) => p.id)).toEqual([...PERSONA_IDS]);
    const markups = SAMPLE_PERSONAS.map((p) => renderToStaticMarkup(<PersonaAvatar persona={p} size={120} />));
    expect(new Set(markups.map((m) => m.replace(/pa-[\w-]+/g, 'id'))).size).toBe(8);
    expect(markups[0]).toContain('aria-label="Петя, 6 лет"');
    expect(markups[0]).toContain('role="img"');
    expect(markups[0]).toContain('width="120"');
    for (const [i, m] of markups.entries()) {
      const p = SAMPLE_PERSONAS[i] as Persona;
      expect(m).toContain(`fill="${p.avatar.bg}"`);
      expect(m).toContain(`fill="${p.avatar.skin}"`);
      expect(m).toContain(p.avatar.hair);
    }
  });

  it('changes the face with the mood', () => {
    const p = SAMPLE_PERSONAS[3] as Persona;
    const [neutral, happy, sad] = (['neutral', 'happy', 'sad'] as const).map((mood) => renderToStaticMarkup(<PersonaAvatar persona={p} mood={mood} />));
    expect(new Set([neutral, happy, sad]).size).toBe(3);
  });

  it('renders every hair style × accessory without throwing, each hair style distinct', () => {
    const base = SAMPLE_PERSONAS[0] as Persona;
    const byHair = HAIR_STYLES.map((hairStyle) => renderToStaticMarkup(<PersonaAvatar persona={{ ...base, avatar: { ...base.avatar, hairStyle, accessory: undefined } }} />));
    expect(new Set(byHair.map((m) => m.replace(/pa-[\w-]+/g, 'id'))).size).toBe(HAIR_STYLES.length);
    for (const hairStyle of HAIR_STYLES) {
      for (const accessory of ACCESSORIES) {
        const html = renderToStaticMarkup(<PersonaAvatar persona={{ ...base, avatar: { ...base.avatar, hairStyle, accessory } }} />);
        expect(html.length).toBeGreaterThan(byHair[0]?.length ? 500 : 0);
      }
    }
  });

  it('can be decorative and never breaks on odd colours', () => {
    const base = SAMPLE_PERSONAS[1] as Persona;
    const html = renderToStaticMarkup(<PersonaAvatar persona={{ ...base, avatar: { ...base.avatar, bg: 'tomato', hair: 'not-a-colour' } }} label="" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });
});

describe('Stars', () => {
  it('labels the value in Russian and clamps it', () => {
    expect(starsLabelRu(1, 3)).toBe('1 звезда из 3');
    expect(starsLabelRu(2, 3)).toBe('2 звезды из 3');
    expect(starsLabelRu(5, 5)).toBe('5 звёзд из 5');
    expect(starsLabelRu(2.5, 3)).toBe('2,5 звезды из 3');
    const html = renderToStaticMarkup(<Stars value={9} max={3} />);
    expect(html).toContain('aria-label="3 звезды из 3"');
    expect((html.match(/data-kind="full"/g) ?? []).length).toBe(3);
    const half = renderToStaticMarkup(<Stars value={1.5} />);
    expect(half).toContain('data-kind="half"');
    expect((half.match(/data-kind="empty"/g) ?? []).length).toBe(1);
  });
});

describe('ProgressBar', () => {
  it('exposes progressbar semantics and clamps the value', () => {
    const html = renderToStaticMarkup(<ProgressBar value={7} max={10} label="Вилки" valueText="7 из 10" />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="7"');
    expect(html).toContain('aria-valuemax="10"');
    expect(html).toContain('aria-label="Вилки"');
    expect(html).toContain('width:70%');
    const over = renderToStaticMarkup(<ProgressBar value={250} valueText />);
    expect(over).toContain('aria-valuenow="100"');
    expect(over).toContain('100%');
    expect(renderToStaticMarkup(<ProgressBar value={Number.NaN} />)).toContain('aria-valuenow="0"');
  });
});

describe('Card, Badge, Spinner, Modal, Icon', () => {
  it('Card renders an optional heading', () => {
    const html = renderToStaticMarkup(
      <Card as="section" title="Прогресс" tone="sunny">
        <p>текст</p>
      </Card>,
    );
    expect(html).toMatch(/^<section/);
    expect(html).toContain('<h3');
    expect(html).toContain('data-tone="sunny"');
  });

  it('Badge renders text with a tone', () => {
    expect(renderToStaticMarkup(<Badge tone="coral">Новое</Badge>)).toContain('data-tone="coral"');
  });

  it('Spinner is a polite status with a Russian label', () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Загружаю…');
  });

  it('Modal is a labelled native dialog; non-dismissible dialogs have no close button', () => {
    const open = renderToStaticMarkup(
      <Modal open onClose={() => undefined} title="Готово!" actions={<Button>Ок</Button>}>
        <p>Молодец</p>
      </Modal>,
    );
    expect(open).toMatch(/^<dialog/);
    expect(open).toContain('aria-labelledby=');
    expect(open).toContain('aria-label="Закрыть"');
    const forced = renderToStaticMarkup(<Modal open onClose={() => undefined} title="Точно сдаёшься?" dismissible={false} />);
    expect(forced).not.toContain('Закрыть');
  });

  it('every icon renders and is hidden from assistive tech unless labelled', () => {
    for (const name of ICON_NAMES) expect(renderToStaticMarkup(<Icon name={name} />)).toContain('aria-hidden="true"');
    const labelled = renderToStaticMarkup(<Icon name="lock" label="Закрыто" />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Закрыто"');
  });
});
