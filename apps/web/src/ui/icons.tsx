import type { ReactNode } from 'react';

/**
 * Small hand-drawn icon set (24 × 24 grid, thick rounded strokes) so the app needs no icon package.
 * Icons are decorative by default; pass `label` (Russian) when an icon stands alone without text.
 */
export const ICON_NAMES = [
  'back',
  'forward',
  'close',
  'check',
  'star',
  'bulb',
  'undo',
  'flag',
  'play',
  'pawn',
  'gear',
  'mic',
  'micOff',
  'sound',
  'soundOff',
  'lock',
  'clock',
  'home',
  'chart',
  'refresh',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const SPEAKER = 'M4 9.5v5h3.5l4.5 4v-13l-4.5 4z';
const MIC_BODY = 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z';
const MIC_STAND = 'M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6';

const GLYPHS: Record<IconName, ReactNode> = {
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  forward: <path d="M5 12h14M13 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  star: <path d="M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6.1L12 16.7l-5.4 3 1.2-6.1-4.5-4.2 6.1-.8z" fill="currentColor" />,
  bulb: (
    <>
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2v.7h5.2v-.7c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
      <path d="M10 20.5h4" />
    </>
  ),
  undo: <path d="M8 5L3 10l5 5M3 10h11a5.5 5.5 0 0 1 0 11H9" />,
  flag: <path d="M6 21V4M6 4.5h11l-2.5 4 2.5 4H6" />,
  play: <path d="M8 5.6v12.8a1 1 0 0 0 1.5.9l10.4-6.4a1 1 0 0 0 0-1.8L9.5 4.7A1 1 0 0 0 8 5.6z" fill="currentColor" />,
  pawn: (
    <>
      <circle cx="12" cy="6.5" r="3.2" fill="currentColor" />
      <path d="M9 11h6M10.2 11c-.2 3-1.4 5-3.4 6.8V20h10.4v-2.2C15.2 16 14 14 13.8 11" fill="currentColor" />
    </>
  ),
  gear: (
    <path
      d="M10.42 5.18L10.5 2.52L13.5 2.52L13.58 5.18L15.7 6.06L17.64 4.23L19.77 6.36L17.94 8.3L18.82 10.42L21.48 10.5L21.48 13.5L18.82 13.58L17.94 15.7L19.77 17.64L17.64 19.77L15.7 17.94L13.58 18.82L13.5 21.48L10.5 21.48L10.42 18.82L8.3 17.94L6.36 19.77L4.23 17.64L6.06 15.7L5.18 13.58L2.52 13.5L2.52 10.5L5.18 10.42L6.06 8.3L4.23 6.36L6.36 4.23L8.3 6.06ZM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z"
      fill="currentColor"
      fillRule="evenodd"
      strokeWidth={1.4}
    />
  ),
  mic: (
    <>
      <path d={MIC_BODY} />
      <path d={MIC_STAND} />
    </>
  ),
  micOff: (
    <>
      <path d={MIC_BODY} />
      <path d={MIC_STAND} />
      <path d="M4 4l16 16" />
    </>
  ),
  sound: (
    <>
      <path d={SPEAKER} fill="currentColor" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  soundOff: (
    <>
      <path d={SPEAKER} fill="currentColor" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </>
  ),
  lock: (
    <>
      <path d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3" />
      <rect x="4.5" y="11" width="15" height="9.5" rx="2.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  home: <path d="M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5.5h4V20" />,
  chart: <path d="M4 20h16M7.5 20v-6M12 20V6M16.5 20v-9" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5" />,
};

export interface IconProps {
  name: IconName;
  /** Pixel size; by default the icon fills its container's font-size (1em). */
  size?: number | string;
  /** Russian accessible name. Without it the icon is hidden from assistive technology. */
  label?: string;
  className?: string;
}

export function Icon({ name, size = '1em', label, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
