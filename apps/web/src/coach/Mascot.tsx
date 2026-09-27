/**
 * «Гамбитик» — the foal chess knight. Pure presentational, layered inline SVG.
 *
 * Two independent channels (research 08 §2.3):
 *  - `pose`       → `data-pose` attribute, everything else is CSS (Mascot.css)
 *  - `mouthLevel` → CSS custom property `--mouth` (0..1) that scales the open mouth
 *
 * For 60 fps lip-sync without React re-renders leave `mouthLevel` undefined and write
 * `--mouth` straight to the root element through `ref` (see `setMascotMouth`).
 */
import { useId } from 'react';
import type { CSSProperties, ReactElement, Ref } from 'react';
import type { MascotPose } from '@gambit/shared';
import './Mascot.css';

export interface MascotProps {
  pose: MascotPose;
  /** 0..1 mouth-open level. Leave undefined when the host component drives `--mouth` through `ref`. */
  mouthLevel?: number;
  /** rendered width in CSS px (height follows the 6:7 canvas). Default 180. */
  size?: number;
  /** adds the little "talking" head bob; defaults to `mouthLevel > 0.04` */
  talking?: boolean;
  /** accessible name; pass an empty string to hide the mascot from assistive tech */
  label?: string;
  className?: string;
  ref?: Ref<SVGSVGElement>;
}

export const MASCOT_VIEWBOX = { width: 240, height: 280 } as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Imperative lip-sync helper: writes the `--mouth` variable without touching React state. */
export function setMascotMouth(root: SVGSVGElement | null, level: number): void {
  root?.style.setProperty('--mouth', clamp01(level).toFixed(3));
}

type MascotStyle = CSSProperties & { '--mouth'?: string };

/** A soft four-point sparkle centred on 0,0. */
const SPARKLE_PATH = 'M0 -12 C1.6 -4 4 -1.6 12 0 C4 1.6 1.6 4 0 12 C-1.6 4 -4 1.6 -12 0 C-4 -1.6 -1.6 -4 0 -12 Z';

export function Mascot({ pose, mouthLevel, size = 180, talking, label = 'Гамбитик', className, ref }: MascotProps): ReactElement {
  const uid = useId();
  const mouthClipId = `${uid}-mouth`;
  const level = mouthLevel === undefined ? undefined : clamp01(mouthLevel);
  const isTalking = talking ?? (level !== undefined && level > 0.04);
  const style: MascotStyle = level === undefined ? {} : { '--mouth': level.toFixed(3) };
  const height = Math.round((size * MASCOT_VIEWBOX.height) / MASCOT_VIEWBOX.width);

  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${MASCOT_VIEWBOX.width} ${MASCOT_VIEWBOX.height}`}
      width={size}
      height={height}
      className={className ? `gmb-mascot ${className}` : 'gmb-mascot'}
      data-pose={pose}
      data-talking={isTalking ? 'true' : 'false'}
      style={style}
      role={label === '' ? 'presentation' : 'img'}
      aria-label={label === '' ? undefined : label}
      aria-hidden={label === '' ? true : undefined}
      focusable="false"
    >
      <defs>
        <clipPath id={mouthClipId}>
          <path d="M103 156 Q120 151 137 156 Q136 180 120 180 Q104 180 103 156 Z" />
        </clipPath>
      </defs>

      <ellipse className="gmb-shadow" cx="120" cy="270" rx="74" ry="8" />

      <g className="gmb-hopper">
        {/* tail — peeks out behind the body */}
        <g className="gmb-tail">
          <path className="gmb-fill-mane" d="M92 230 C62 240 36 220 39 190 C40 175 50 164 63 162 C58 177 62 194 78 203 C86 208 92 216 92 230 Z" />
          <path className="gmb-fill-mane-light" d="M82 226 C64 228 50 216 48 198 C56 210 68 214 80 214 C82 218 83 222 82 226 Z" />
        </g>

        {/* pedestal: the foot of a chess piece */}
        <g className="gmb-base">
          <rect className="gmb-fill-base-dark" x="44" y="250" width="152" height="22" rx="11" />
          <rect className="gmb-fill-base" x="56" y="236" width="128" height="20" rx="10" />
          <rect className="gmb-fill-base-light" x="72" y="226" width="96" height="14" rx="7" />
          <rect className="gmb-gloss" x="68" y="240" width="46" height="4" rx="2" />
        </g>

        {/* body */}
        <g className="gmb-body">
          <ellipse className="gmb-fill-hide-shade" cx="86" cy="226" rx="17" ry="10" />
          <ellipse className="gmb-fill-hide-shade" cx="154" cy="226" rx="17" ry="10" />
          <path className="gmb-fill-hoof" d="M70 228 C70 222 76 219 82 220 L82 236 L76 236 C72 236 70 232 70 228 Z" />
          <path className="gmb-fill-hoof" d="M170 228 C170 222 164 219 158 220 L158 236 L164 236 C168 236 170 232 170 228 Z" />
          <path className="gmb-fill-hide" d="M90 150 H150 L160 204 H80 Z" />
          <path className="gmb-fill-hide" d="M78 234 C70 204 80 182 98 172 L142 172 C160 182 170 204 162 234 Z" />
          <path className="gmb-fill-cream" d="M100 234 C97 216 104 202 120 197 C136 202 143 216 140 234 Z" />
          {/* resting front leg */}
          <g className="gmb-leg">
            <rect className="gmb-fill-hide-shade" x="93" y="194" width="21" height="42" rx="10.5" />
            <path className="gmb-fill-hoof" d="M93 222 H114 V225.5 C114 231.3 109.3 236 103.5 236 C97.7 236 93 231.3 93 225.5 Z" />
          </g>
        </g>

        {/* scarf in the accent colour */}
        <g className="gmb-scarf">
          <g className="gmb-scarf-tails">
            <path className="gmb-fill-scarf-dark" d="M80 190 L64 218 L76 225 L90 196 Z" />
            <path className="gmb-fill-scarf" d="M84 194 L80 230 L93 231 L95 197 Z" />
            <path className="gmb-scarf-stripe" d="M81.5 221.5 L92.6 222.4" />
            <path className="gmb-scarf-stripe" d="M68.5 213.5 L78.5 219" />
          </g>
          <path className="gmb-fill-scarf" d="M80 176 C98 192 142 192 160 176 L162 192 C144 208 96 208 78 192 Z" />
          <path className="gmb-scarf-stripe" d="M84 187 C102 200 138 200 156 187" />
          <rect className="gmb-fill-scarf-dark" x="77" y="183" width="19" height="16" rx="6.5" transform="rotate(24 86 191)" />
        </g>

        {/* head */}
        <g className="gmb-head">
          <g className="gmb-head-breathe">
            <g className="gmb-head-talk">
              <g className="gmb-mane">
                <path
                  className="gmb-fill-mane"
                  d="M148 36 C178 34 202 54 205 86 C216 102 218 126 209 144 C216 164 208 190 190 208 C192 192 184 178 166 172 L162 80 Z"
                />
                <path className="gmb-fill-mane-light" d="M176 58 C196 70 202 98 196 120 C192 102 184 90 174 84 Z" />
                <path className="gmb-fill-mane-light" d="M190 132 C204 148 202 172 192 190 C193 172 188 158 180 150 Z" />
              </g>

              <g transform="translate(84 56) rotate(-20)">
                <g className="gmb-ear gmb-ear-l">
                  <path className="gmb-fill-hide" d="M-15 4 C-20 -24 -9 -46 0 -56 C9 -46 20 -24 15 4 Z" />
                  <path className="gmb-fill-pink" d="M-7.5 0 C-11 -20 -5 -36 0 -43 C5 -36 11 -20 7.5 0 Z" />
                </g>
              </g>
              <g transform="translate(156 56) rotate(20)">
                <g className="gmb-ear gmb-ear-r">
                  <path className="gmb-fill-hide" d="M-15 4 C-20 -24 -9 -46 0 -56 C9 -46 20 -24 15 4 Z" />
                  <path className="gmb-fill-pink" d="M-7.5 0 C-11 -20 -5 -36 0 -43 C5 -36 11 -20 7.5 0 Z" />
                </g>
              </g>

              {/* skull */}
              <path
                className="gmb-fill-hide"
                d="M120 34 C160 34 186 60 186 94 C186 114 180 128 171 138 L171 156 C160 172 140 176 120 176 C100 176 80 172 69 156 L69 138 C60 128 54 114 54 94 C54 60 80 34 120 34 Z"
              />
              {/* blaze */}
              <path className="gmb-fill-cream" d="M113 52 C117 47 123 47 127 52 C129 76 131 98 137 118 L103 118 C109 98 111 76 113 52 Z" />

              {/* muzzle */}
              <g className="gmb-muzzle">
                <path
                  className="gmb-fill-cream"
                  d="M120 110 C148 110 168 124 172 147 C174 169 151 184 120 184 C89 184 66 169 68 147 C72 124 92 110 120 110 Z"
                />
                <ellipse className="gmb-fill-nostril" cx="103" cy="139" rx="3.6" ry="5.2" transform="rotate(14 103 139)" />
                <ellipse className="gmb-fill-nostril" cx="137" cy="139" rx="3.6" ry="5.2" transform="rotate(-14 137 139)" />
              </g>

              <ellipse className="gmb-cheek" cx="68" cy="126" rx="11" ry="7.5" />
              <ellipse className="gmb-cheek" cx="172" cy="126" rx="11" ry="7.5" />

              {/* forelock */}
              <g className="gmb-forelock">
                <path
                  className="gmb-fill-mane"
                  d="M98 44 C100 22 132 12 148 32 C154 46 146 60 134 66 C138 56 134 48 126 50 C122 60 112 68 98 66 C104 62 106 56 104 52 C98 54 92 52 98 44 Z"
                />
                <path className="gmb-fill-mane-light" d="M112 30 C122 22 138 26 142 38 C134 32 124 32 116 38 Z" />
              </g>

              {/* eyes */}
              <g className="gmb-eyes">
                <g className="gmb-eye-open">
                  <ellipse className="gmb-eye-white gmb-eye-white-l" cx="88" cy="98" rx="16" ry="19" />
                  <ellipse className="gmb-eye-white gmb-eye-white-r" cx="152" cy="98" rx="16" ry="19" />
                  <g className="gmb-pupils">
                    <g className="gmb-pupil gmb-pupil-l">
                      <circle className="gmb-fill-ink" cx="90" cy="100" r="10.5" />
                      <circle fill="#fff" cx="94" cy="95" r="4" />
                      <circle fill="#fff" cx="86" cy="105" r="1.8" opacity=".85" />
                    </g>
                    <g className="gmb-pupil gmb-pupil-r">
                      <circle className="gmb-fill-ink" cx="150" cy="100" r="10.5" />
                      <circle fill="#fff" cx="154" cy="95" r="4" />
                      <circle fill="#fff" cx="146" cy="105" r="1.8" opacity=".85" />
                    </g>
                  </g>
                  <g className="gmb-lids">
                    <g className="gmb-lid gmb-lid-l">
                      <ellipse className="gmb-fill-hide" cx="88" cy="98" rx="17.5" ry="20.5" />
                      <path className="gmb-lash" d="M74 106 Q88 118 102 106" />
                    </g>
                    <g className="gmb-lid gmb-lid-r">
                      <ellipse className="gmb-fill-hide" cx="152" cy="98" rx="17.5" ry="20.5" />
                      <path className="gmb-lash" d="M138 106 Q152 118 166 106" />
                    </g>
                  </g>
                </g>
                <g className="gmb-eye-happy">
                  <path className="gmb-lash" d="M73 104 Q88 82 103 104" />
                  <path className="gmb-lash" d="M137 104 Q152 82 167 104" />
                </g>
              </g>

              <g className="gmb-brows">
                <path className="gmb-brow gmb-brow-l" d="M74 72 Q87 64 101 71" />
                <path className="gmb-brow gmb-brow-r" d="M139 71 Q153 64 166 72" />
              </g>

              {/* mouth: smile when closed, scales open with --mouth */}
              <g className="gmb-mouth">
                <path className="gmb-smile" d="M105 157 Q120 171 135 157" />
                <g className="gmb-mouth-open">
                  <path className="gmb-fill-mouth" d="M103 156 Q120 151 137 156 Q136 180 120 180 Q104 180 103 156 Z" />
                  <ellipse className="gmb-fill-pink" cx="120" cy="178" rx="11" ry="7" clipPath={`url(#${mouthClipId})`} />
                </g>
              </g>
            </g>
          </g>
        </g>

        {/* the waving front leg ("arm") */}
        <g className="gmb-arm">
          <g className="gmb-arm-anim">
            <rect className="gmb-fill-hide-shade" x="135" y="194" width="21" height="42" rx="10.5" />
            <path className="gmb-fill-hoof" d="M135 222 H156 V225.5 C156 231.3 151.3 236 145.5 236 C139.7 236 135 231.3 135 225.5 Z" />
          </g>
        </g>

        {/* pose effects */}
        <g className="gmb-fx" aria-hidden="true">
          <g className="gmb-fx-zzz">
            <text x="182" y="46" fontSize="20">z</text>
            <text x="198" y="28" fontSize="26">Z</text>
            <text x="216" y="6" fontSize="32">Z</text>
          </g>
          <path className="gmb-fx-drop" d="M44 62 C37 75 34 82 44 87 C54 82 51 75 44 62 Z" />
          <g className="gmb-fx-dots">
            <circle cx="196" cy="40" r="5" />
            <circle cx="211" cy="24" r="7" />
            <circle cx="229" cy="6" r="9" />
          </g>
          <g className="gmb-fx-stars">
            <g transform="translate(24 70) scale(1.5)"><path className="gmb-star" d={SPARKLE_PATH} /></g>
            <g transform="translate(220 96) scale(1.2)"><path className="gmb-star" d={SPARKLE_PATH} /></g>
            <g transform="translate(36 160)"><path className="gmb-star" d={SPARKLE_PATH} /></g>
            <g transform="translate(208 18) scale(.9)"><path className="gmb-star" d={SPARKLE_PATH} /></g>
          </g>
          <g className="gmb-fx-waves">
            <path d="M44 40 Q34 22 42 4" />
            <path d="M30 46 Q16 22 28 -4" />
          </g>
        </g>
      </g>
    </svg>
  );
}
