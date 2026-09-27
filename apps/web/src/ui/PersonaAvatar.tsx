import { useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Persona, PersonaId } from '@gambit/shared';
import { shade } from './color.ts';
import { pluralRu } from './plural.ts';

/** neutral = the persona's own default expression; happy / sad change only eyes, brows and mouth. */
export type PersonaMood = 'neutral' | 'happy' | 'sad';

export type PersonaAvatarData = Pick<Persona, 'id' | 'name' | 'age' | 'avatar'>;

export interface PersonaAvatarProps {
  persona: PersonaAvatarData;
  /** Pixel size of the round avatar. Default 96. */
  size?: number;
  mood?: PersonaMood;
  /** Accessible name override. Default «Петя, 6 лет». Pass '' to make the avatar decorative. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

type HairStyle = Persona['avatar']['hairStyle'];
type Accessory = NonNullable<Persona['avatar']['accessory']>;
type EyeStyle = 'dot' | 'arc' | 'calm';
type BrowStyle = 'soft' | 'raisedOne' | 'focused' | 'flat';
type MouthStyle = 'smile' | 'grin' | 'smirk' | 'gentle' | 'half' | 'cool';

/** Little per-character details that Persona.avatar cannot express; keyed by id, all optional. */
interface Quirks {
  eyes: EyeStyle;
  brows: BrowStyle;
  mouth: MouthStyle;
  freckles?: boolean;
  /** 'ponytail' is drawn as two side pigtails */
  twinTails?: boolean;
  starClip?: boolean;
  /** coloured frame around the avatar */
  ring?: string;
  /** hood behind the head + hoodie strings */
  hood?: string;
  shirt?: string;
  shirtStripes?: string;
  collar?: boolean;
  capColor?: string;
  bowColor?: string;
  scarfColor?: string;
  headphoneAccent?: string;
}

const DEFAULT_QUIRKS: Quirks = { eyes: 'dot', brows: 'soft', mouth: 'smile' };

const QUIRKS: Record<PersonaId, Quirks> = {
  petya: { eyes: 'dot', brows: 'soft', mouth: 'grin', shirt: '#FFFFFF', shirtStripes: '#2F9E63' },
  sonya: { eyes: 'arc', brows: 'soft', mouth: 'smile', twinTails: true, bowColor: '#FF7A93', shirt: '#FF8FA3' },
  grisha: { eyes: 'dot', brows: 'raisedOne', mouth: 'smirk', freckles: true, shirt: '#2F7D5B' },
  sasha: { eyes: 'dot', brows: 'soft', mouth: 'smile', capColor: '#2F6FDE', shirt: '#FFFFFF' },
  vika: { eyes: 'dot', brows: 'focused', mouth: 'half', starClip: true, shirt: '#FFD23F' },
  lyova: { eyes: 'dot', brows: 'soft', mouth: 'gentle', shirt: '#F7F1E3', collar: true },
  nika: { eyes: 'dot', brows: 'soft', mouth: 'half', headphoneAccent: '#FFD23F', shirt: '#26304F' },
  dima: { eyes: 'calm', brows: 'flat', mouth: 'cool', ring: '#E8B931', hood: '#3A3F5C', shirt: '#3A3F5C', scarfColor: '#E8B931' },
};

const INK = '#26304F';
const MOUTH = '#7A2E3B';
const BLUSH = '#FF8FA3';

const FRONT_SIDE_SWEPT = 'M24.5 44C22 27 33 15 48 15c16 0 26.5 12 23.5 29-1-7-3.5-12-7.5-15.5C54 27 40 29 31 37c-3 2-5 4-6.5 7Z';
const FRONT_CENTER_PART = 'M24.5 45C22 27 33 15 48 15s26 12 23.5 30C69 36 60 29 48 24.5 36 29 27 36 24.5 45Z';

function mirror(x: number): number {
  return 96 - x;
}

// ───────────────────────── hair ─────────────────────────

function hairBack(style: HairStyle, hair: string, q: Quirks, capped: boolean): ReactNode {
  const deep = shade(hair, -0.18);
  switch (style) {
    case 'curly': {
      const curls: ReactNode[] = [];
      for (let i = 0; i <= 8; i++) {
        const angle = ((195 - i * 26.25) * Math.PI) / 180;
        curls.push(<circle key={i} cx={round(48 + 27 * Math.cos(angle))} cy={round(40 - 25 * Math.sin(angle))} r={8.6} />);
      }
      return <g fill={deep}>{curls}</g>;
    }
    case 'ponytail':
      if (q.twinTails) {
        return (
          <g fill={deep}>
            <path d="M29 31C14 29 6 44 10 60c2 8 9 10 12 5-3-9-1-19 7-23Z" />
            <path d="M67 31c15-2 23 13 19 29-2 8-9 10-12 5 3-9 1-19-7-23Z" />
          </g>
        );
      }
      return <path d="M61 21C71 9 89 13 89 30c0 12-6 20-11 29 1-12-3-21-10-28Z" fill={deep} />;
    case 'bob':
      return <path d="M21 40C21 20 34 12.5 48 12.5S75 20 75 40l1.5 22c.5 6-4.5 8.5-9.5 7H29c-5 1.5-10-1-9.5-7Z" fill={deep} />;
    case 'long':
      return <path d="M20 42C19 22 33 12.5 48 12.5S77 22 76 42c0 16 3 30 7 42-9 4-17 0-19-8H32c-2 8-10 12-19 8 4-12 7-26 7-42Z" fill={deep} />;
    case 'bun':
      // a cap sits where the bun would be
      if (capped) return null;
      return (
        <g>
          <circle cx={48} cy={11} r={10} fill={deep} />
          <path d="M42 8c3-3 9-3 12 0" stroke={shade(hair, 0.25)} strokeWidth={1.8} strokeLinecap="round" fill="none" opacity={0.7} />
        </g>
      );
    default:
      return null;
  }
}

function hairFront(style: HairStyle, hair: string, q: Quirks, capped: boolean): ReactNode {
  const light = shade(hair, 0.28);
  // spikes would poke through a cap: show the tufts of the 'cap' style instead
  if (capped && style === 'spiky') return hairFront('cap', hair, q, true);
  const shine = <path d="M37 20.5c8-3.5 18-3 25 1.5" stroke={light} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0.55} />;
  switch (style) {
    case 'short':
      return (
        <g>
          <path d="M24.5 44C22 27 33 14.5 49 14.5S75 27 71.5 44c-1.5-6-4-10.5-8.5-13.5-8 5-22 4.5-29.5-2-5 3.5-8 8.5-9 15.5Z" fill={hair} />
          <path d="M34 28c2-4 5-7 9-9" stroke={light} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0.55} />
        </g>
      );
    case 'spiky':
      return (
        <path
          d="M24.5 43c-1.5-8 .5-14 3.5-18l-2.5-10 8.5 5 3-11 7 8 6-11 5 11 8-7 .5 11 8.5-4-3 10c3 5 3.5 10 2.5 16-2.5-6-6.5-10-11.5-11.5l-4.5 4-4.5-4.5-5 4.5-5-4.5c-8 1-14 5.5-16.5 12Z"
          fill={hair}
          stroke={hair}
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      );
    case 'curly':
      return (
        <g fill={hair}>
          <path d="M25 40c0-16 11-23 23-23s23 7 23 23c-5-8-13-12-23-12s-18 4-23 12Z" />
          <circle cx={31.5} cy={31} r={6.4} />
          <circle cx={40} cy={26.5} r={6.6} />
          <circle cx={49} cy={25} r={6.6} />
          <circle cx={58} cy={27} r={6.4} />
          <circle cx={65} cy={32} r={6} />
          <circle cx={43} cy={22} r={1.6} fill={light} opacity={0.6} />
          <circle cx={56} cy={22.5} r={1.4} fill={light} opacity={0.6} />
        </g>
      );
    case 'ponytail':
      if (q.twinTails) {
        return (
          <g>
            <path d={FRONT_CENTER_PART} fill={hair} />
            <path d="M48 15.5v8.5" stroke={shade(hair, -0.25)} strokeWidth={1.6} strokeLinecap="round" />
          </g>
        );
      }
      return (
        <g>
          <path d={FRONT_SIDE_SWEPT} fill={hair} />
          {shine}
          <circle cx={65.5} cy={23} r={3.2} fill={q.bowColor ?? light} />
        </g>
      );
    case 'bob':
      return (
        <g>
          <path d="M25 41c-1-15 9-25 23-25s24 10 23 25c0-3-1-5-2-6.5-13 2.5-29 2.5-42-.5-1 2-2 4-2 7Z" fill={hair} />
          {shine}
        </g>
      );
    case 'cap':
      return (
        <g fill={hair}>
          <path d="M24.5 46c-1-7 .5-12 2.5-15.5l6 1c-3 4-4.5 8.5-5 13.5Z" />
          <path d="M71.5 46c1-7-.5-12-2.5-15.5l-6 1c3 4 4.5 8.5 5 13.5Z" />
          <path d="M33 31c5 4.5 12 5 18 1.5Z" />
        </g>
      );
    case 'long':
      return (
        <g>
          <path d={FRONT_CENTER_PART} fill={hair} />
          <path d="M48 15.5v8.5" stroke={shade(hair, -0.25)} strokeWidth={1.6} strokeLinecap="round" />
          {shine}
        </g>
      );
    case 'bun':
      return (
        <g>
          <path d={FRONT_SIDE_SWEPT} fill={hair} />
          {shine}
        </g>
      );
  }
}

// ───────────────────────── accessories ─────────────────────────

function Cap({ color }: { color: string }) {
  const deep = shade(color, -0.22);
  return (
    <g transform="rotate(-6 48 30)">
      <path d="M23.5 33C23 19 34 11 48 11s25 8 24.5 22c-8.5-3.5-40.5-3.5-49 0Z" fill={color} />
      <path d="M23.5 33c8.5-3.5 40.5-3.5 49 0v3.2c-8.5-3.5-40.5-3.5-49 0Z" fill={deep} />
      <path d="M50 31.5c12-1.5 28 0 36 6 1.5 1.5.5 3.5-1.5 3-10.5-3.5-22.5-4.5-34.5-4Z" fill={deep} />
      <path d="M36 17c3-2.5 7-4 11-4.5" stroke={shade(color, 0.35)} strokeWidth={2} strokeLinecap="round" fill="none" opacity={0.7} />
      <circle cx={48} cy={11.5} r={2.3} fill={deep} />
    </g>
  );
}

function Bow({ x, y, color, scale = 1 }: { x: number; y: number; color: string; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path d="M0 0c-5-7-12-6-11 0-1 6 6 7 11 0Z" fill={color} />
      <path d="M0 0c5-7 12-6 11 0 1 6-6 7-11 0Z" fill={color} />
      <circle r={2.9} fill={shade(color, -0.25)} />
    </g>
  );
}

function accessoryLayer(accessory: Accessory | undefined, q: Quirks, hairStyle: HairStyle, bg: string): ReactNode {
  const parts: ReactNode[] = [];
  const wantsCap = accessory === 'cap' || hairStyle === 'cap';
  if (wantsCap) parts.push(<Cap key="cap" color={q.capColor ?? '#2F6FDE'} />);

  if (accessory === 'glasses') {
    parts.push(
      <g key="glasses" stroke={INK} strokeWidth={2.2} strokeLinecap="round" fill="none">
        <circle cx={39.5} cy={46} r={6.7} fill="#FFFFFF" fillOpacity={0.3} />
        <circle cx={56.5} cy={46} r={6.7} fill="#FFFFFF" fillOpacity={0.3} />
        <path d="M46.1 45.3q1.9-1.6 3.8 0M32.9 45l-6.4-1.7M63.1 45l6.4-1.7" />
      </g>,
    );
  }
  if (accessory === 'headphones') {
    const accent = q.headphoneAccent ?? '#FFD23F';
    parts.push(
      <g key="headphones">
        <path d="M22.5 46C20.5 22 35 9.5 48 9.5S75.5 22 73.5 46" stroke={INK} strokeWidth={4.2} strokeLinecap="round" fill="none" />
        <rect x={16.5} y={38} width={11} height={18} rx={5.5} fill={INK} />
        <rect x={68.5} y={38} width={11} height={18} rx={5.5} fill={INK} />
        <rect x={18.7} y={42} width={2.8} height={10} rx={1.4} fill={accent} />
        <rect x={74.5} y={42} width={2.8} height={10} rx={1.4} fill={accent} />
      </g>,
    );
  }
  if (accessory === 'bow') {
    const color = q.bowColor ?? '#FF7A93';
    if (hairStyle === 'ponytail' && q.twinTails) {
      parts.push(<Bow key="bowL" x={25} y={31} color={color} scale={0.82} />, <Bow key="bowR" x={mirror(25)} y={31} color={color} scale={0.82} />);
    } else {
      parts.push(<Bow key="bow" x={65} y={21} color={color} />);
    }
  }
  if (accessory === 'scarf') {
    const color = q.scarfColor ?? pickContrast(bg, '#FF6B5E', '#FFB938');
    parts.push(
      <g key="scarf">
        <path d="M55 77l8 1.5-1 15-8-1Z" fill={shade(color, -0.15)} />
        <path d="M30.5 67.5c7 7 28 7 35 0l2.5 8c-10 8-30 8-40 0Z" fill={color} />
        <path d="M36 75.5l1.5 4.5M47 77.5v5M58 76l-1.5 4.5" stroke={shade(color, 0.4)} strokeWidth={1.8} strokeLinecap="round" opacity={0.8} />
      </g>,
    );
  }
  if (q.starClip) {
    parts.push(
      <path key="clip" d="M66 24.5l1.8 3.7 4.1.5-3 2.8.8 4-3.7-2-3.7 2 .8-4-3-2.8 4.1-.5Z" fill="#FFD23F" stroke="#E0A800" strokeWidth={0.8} strokeLinejoin="round" />,
    );
  }
  return parts.length > 0 ? parts : null;
}

/** Picks the candidate that differs most from the background so the scarf never melts into it. */
function pickContrast(bg: string, a: string, b: string): string {
  return colorDistance(bg, a) >= colorDistance(bg, b) ? a : b;
}

function colorDistance(a: string, b: string): number {
  const pa = parseHexLoose(a);
  const pb = parseHexLoose(b);
  return Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]);
}

function parseHexLoose(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ───────────────────────── face ─────────────────────────

function eyes(style: EyeStyle, mood: PersonaMood): ReactNode {
  const xs = [39.5, 56.5];
  if (mood === 'happy' || style === 'arc') {
    const lift = mood === 'sad' ? 1 : 0;
    return (
      <g stroke={INK} strokeWidth={2.7} strokeLinecap="round" fill="none">
        {xs.map((x) => (
          <path key={x} d={`M${x - 3.6} ${47.4 + lift}q3.6-${mood === 'sad' ? 3 : 4.8} 7.2 0`} />
        ))}
      </g>
    );
  }
  return (
    <g>
      {xs.map((x) => (
        <g key={x}>
          <circle cx={x} cy={46} r={3.35} fill={INK} />
          <circle cx={x + 1.15} cy={44.8} r={1.1} fill="#FFFFFF" />
          {style === 'calm' ? <path d={`M${x - 4.2} 43.3h8.4`} stroke={INK} strokeWidth={2.1} strokeLinecap="round" /> : null}
        </g>
      ))}
    </g>
  );
}

function brows(style: BrowStyle, mood: PersonaMood, color: string): ReactNode {
  let left: string;
  let right: string;
  if (mood === 'sad') {
    left = 'M35.5 40.2q4.5-2.8 8-3.2';
    right = 'M60.5 40.2q-4.5-2.8-8-3.2';
  } else if (mood === 'happy') {
    left = 'M35.5 38q4-3.4 8 0';
    right = 'M52.5 38q4-3.4 8 0';
  } else {
    switch (style) {
      case 'raisedOne':
        left = 'M35.5 39.8q4-2.3 8-.3';
        right = 'M52.5 36.8q4.5-3.3 8.5-.3';
        break;
      case 'focused':
        left = 'M35.5 38.2q4 .1 8 1.7';
        right = 'M60.5 38.2q-4 .1-8 1.7';
        break;
      case 'flat':
        left = 'M35.5 39h8';
        right = 'M52.5 39h8';
        break;
      case 'soft':
        left = 'M35.5 39.5q4-2.8 8 0';
        right = 'M52.5 39.5q4-2.8 8 0';
        break;
    }
  }
  return (
    <g stroke={color} strokeWidth={2.3} strokeLinecap="round" fill="none">
      <path d={left} />
      <path d={right} />
    </g>
  );
}

function mouth(style: MouthStyle, mood: PersonaMood): ReactNode {
  if (mood === 'sad') {
    return <path d="M42.5 60.5q5.5-4 11 0" stroke={MOUTH} strokeWidth={2.6} strokeLinecap="round" fill="none" />;
  }
  if (mood === 'happy' || style === 'grin') {
    return (
      <g>
        <path d="M39.5 55.8q8.5 12.4 17 0Z" fill={MOUTH} stroke={MOUTH} strokeWidth={1.6} strokeLinejoin="round" />
        {style === 'grin' ? (
          <>
            <path d="M42.3 56.4h11.4l-.9 2.7h-9.6Z" fill="#FFFFFF" />
            <rect x={46.5} y={56.2} width={3} height={3.2} fill={MOUTH} />
          </>
        ) : (
          <path d="M42.3 56.4h11.4l-.9 2.2h-9.6Z" fill="#FFFFFF" />
        )}
        <path d="M44.3 62.3q3.7-2.3 7.4 0-3.7 3.4-7.4 0Z" fill={BLUSH} />
      </g>
    );
  }
  const d: Record<Exclude<MouthStyle, 'grin'>, string> = {
    smile: 'M41 57.3q7 6.2 14 0',
    smirk: 'M41.5 58.2q7.5 4.3 14.5-2.7',
    gentle: 'M42.5 58q5.5 3.4 11 0',
    half: 'M42 57.8q7.5 4.8 13.5-1.6',
    cool: 'M43 58.6q5.5 2.2 11-.8',
  };
  return <path d={d[style]} stroke={MOUTH} strokeWidth={2.6} strokeLinecap="round" fill="none" />;
}

// ───────────────────────── component ─────────────────────────

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Code-drawn SVG face for a bot persona: background circle in the step colour, skin, one of 8 hair styles,
 * optional accessory, friendly eyes and a smile. Characters stay recognisable at 40 px and look best at 96–160 px.
 */
export function PersonaAvatar({ persona, size = 96, mood = 'neutral', label, className, style }: PersonaAvatarProps) {
  const clipId = `pa-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { bg, skin, hair, hairStyle, accessory } = persona.avatar;
  const q: Quirks = QUIRKS[persona.id] ?? DEFAULT_QUIRKS;
  const skinShade = shade(skin, -0.14);
  const shirt = q.shirt ?? shade(bg, -0.38);
  const browColor = shade(hair, -0.35);
  const accessibleName = label ?? `${persona.name}, ${persona.age} ${pluralRu(persona.age, 'год', 'года', 'лет')}`;
  const decorative = accessibleName === '';
  const capped = accessory === 'cap' || hairStyle === 'cap';

  return (
    <svg
      className={className}
      style={{ flex: 'none', ...style }}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : accessibleName}
      aria-hidden={decorative ? true : undefined}
      data-persona={persona.id}
      data-mood={mood}
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx={48} cy={48} r={48} />
        </clipPath>
      </defs>
      <circle cx={48} cy={48} r={48} fill={bg} />
      <g clipPath={`url(#${clipId})`}>
        {/* soft light spot so the flat circle has a little depth */}
        <circle cx={30} cy={22} r={30} fill="#FFFFFF" opacity={0.13} />
        {/* the character is drawn on a 96-grid and enlarged a little so the face reads well at 32–48 px */}
        <g transform="translate(48 54) scale(1.1) translate(-48 -54)">

        {q.hood ? <path d="M17 60C13 30 28 8 48 8s35 22 31 52c-1 10-6 18-12 22H29c-6-4-11-12-12-22Z" fill={shade(q.hood, -0.12)} /> : null}
        {hairBack(hairStyle, hair, q, capped)}

        {/* shoulders + neck */}
        <path d="M11 100c0-20 17-27.5 37-27.5S85 80 85 100Z" fill={shirt} />
        {q.shirtStripes ? (
          <g stroke={q.shirtStripes} strokeWidth={3.4} fill="none">
            <path d="M17 84.5c9-5 53-5 62 0" />
            <path d="M13 92.5c11-5.5 59-5.5 70 0" />
          </g>
        ) : null}
        <rect x={41.2} y={60} width={13.6} height={17} rx={6} fill={skinShade} />
        <path d="M39.5 73.5q8.5 7.5 17 0l-1.5 3.5q-7 5-14 0Z" fill={shade(shirt, -0.12)} />
        {q.collar ? <path d="M38 73l10 8-7.5 3.5ZM58 73l-10 8 7.5 3.5Z" fill="#FFFFFF" stroke={shade(shirt, -0.2)} strokeWidth={0.9} strokeLinejoin="round" /> : null}
        {q.hood && accessory !== 'scarf' ? (
          <g stroke="#F3EBD8" strokeWidth={1.8} strokeLinecap="round">
            <path d="M42.5 79v9M53.5 79v9" />
          </g>
        ) : null}

        {/* head */}
        <circle cx={25.6} cy={47} r={4.7} fill={skin} />
        <circle cx={70.4} cy={47} r={4.7} fill={skin} />
        <circle cx={25.9} cy={47.2} r={2.1} fill={skinShade} opacity={0.7} />
        <circle cx={70.1} cy={47.2} r={2.1} fill={skinShade} opacity={0.7} />
        <ellipse cx={48} cy={45} rx={23} ry={24.5} fill={skin} />

        {hairFront(hairStyle, hair, q, capped)}

        {/* face */}
        <circle cx={32.8} cy={54} r={4.7} fill={BLUSH} opacity={0.5} />
        <circle cx={63.2} cy={54} r={4.7} fill={BLUSH} opacity={0.5} />
        {q.freckles ? (
          <g fill="#C9822B" opacity={0.85}>
            <circle cx={33} cy={51.5} r={0.95} />
            <circle cx={36.3} cy={53.2} r={0.95} />
            <circle cx={31.2} cy={54.6} r={0.95} />
            <circle cx={63} cy={51.5} r={0.95} />
            <circle cx={59.7} cy={53.2} r={0.95} />
            <circle cx={64.8} cy={54.6} r={0.95} />
          </g>
        ) : null}
        {brows(q.brows, mood, browColor)}
        {eyes(q.eyes, mood)}
        <path d="M46.5 51.3q1.5 1.9 3 0" stroke={shade(skin, -0.3)} strokeWidth={1.7} strokeLinecap="round" fill="none" />
        {mouth(q.mouth, mood)}

        {accessoryLayer(accessory, q, hairStyle, bg)}
        </g>
      </g>
      {q.ring ? <circle cx={48} cy={48} r={46} fill="none" stroke={q.ring} strokeWidth={4} /> : null}
    </svg>
  );
}
