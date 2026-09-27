/**
 * The three charts of the dashboard (Recharts 3). Loaded lazily by ProgressScreen so the chart library
 * stays out of the main bundle.
 *
 * Chart rules followed here: one measure per chart (accuracy and blunders have different scales, so
 * they are two small charts, never a dual axis) · one colour per measure, text always in ink tokens ·
 * 2 px lines, ≥ 8 px markers with a surface ring, thin bars with a rounded data end · hairline
 * horizontal grid · hover tooltip everywhere · only the last point is labelled directly.
 */
import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipContentProps } from 'recharts';
import { getPersona } from '@gambit/content';
import { pluralRu, prefersReducedMotion } from '../../ui/index.ts';
import styles from './ProgressScreen.module.css';
import { isGameChartPoint, isRatingChartPoint, niceDomain } from './progressModel.ts';
import type { GameChartPoint, RatingChartPoint } from './progressModel.ts';

/** Mirrors ui/tokens.css (SVG presentation attributes do not reliably resolve CSS variables). */
const COLOR = {
  accuracy: '#0f6f69',
  blunders: '#c9372e',
  rating: '#c77f00',
  surface: '#ffffff',
  grid: '#e6d9bf',
  tick: '#52667a',
} as const;

const AXIS_TICK = { fill: COLOR.tick, fontSize: 13, fontWeight: 700 } as const;
const MARGIN = { top: 18, right: 34, bottom: 4, left: 0 } as const;

function firstPayload(props: TooltipContentProps): unknown {
  const entry: unknown = props.payload[0];
  return typeof entry === 'object' && entry !== null && 'payload' in entry ? entry.payload : undefined;
}

function TooltipBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>{title}</p>
      {children}
    </div>
  );
}

function gameTooltip(kind: 'accuracy' | 'blunders') {
  return function GameTooltip(props: TooltipContentProps) {
    const point = firstPayload(props);
    if (!props.active || !isGameChartPoint(point)) return null;
    const persona = getPersona(point.personaId);
    return (
      <TooltipBox title={`Партия ${point.n} · ${point.dateLabel}`}>
        {persona ? <p>Соперник: {persona.name}</p> : null}
        <p className={styles.tooltipValue}>{kind === 'accuracy' ? `Точность ${point.accuracy}%` : `${point.blunders} ${pluralRu(point.blunders, 'зевок', 'зевка', 'зевков')}`}</p>
      </TooltipBox>
    );
  };
}

const AccuracyTooltip = gameTooltip('accuracy');
const BlundersTooltip = gameTooltip('blunders');

function RatingTooltip(props: TooltipContentProps) {
  const point = firstPayload(props);
  if (!props.active || !isRatingChartPoint(point)) return null;
  return (
    <TooltipBox title={point.dateLabel}>
      <p className={styles.tooltipValue}>Рейтинг {point.rating}</p>
    </TooltipBox>
  );
}

/** Label only the last point of a series (selective direct labelling). */
function lastOnly<T>(data: readonly T[], format: (row: T) => string) {
  return (_: unknown, index: number): string => {
    const row = data[index];
    return index === data.length - 1 && row !== undefined ? format(row) : '';
  };
}

function tickEvery(count: number): number {
  return count <= 10 ? 0 : Math.ceil(count / 8) - 1;
}

export interface ProgressChartsProps {
  games: GameChartPoint[];
  rating: RatingChartPoint[];
}

export function AccuracyChart({ games }: { games: GameChartPoint[] }) {
  const animate = !prefersReducedMotion();
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={games} margin={MARGIN} accessibilityLayer>
        <CartesianGrid vertical={false} stroke={COLOR.grid} strokeWidth={1} />
        <XAxis dataKey="n" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: COLOR.grid }} interval={tickEvery(games.length)} />
        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip content={AccuracyTooltip} cursor={{ stroke: COLOR.tick, strokeWidth: 1 }} />
        <Line
          type="linear"
          dataKey="accuracy"
          name="Точность"
          stroke={COLOR.accuracy}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          dot={{ r: 4, fill: COLOR.accuracy, stroke: COLOR.surface, strokeWidth: 2 }}
          activeDot={{ r: 7, fill: COLOR.accuracy, stroke: COLOR.surface, strokeWidth: 2 }}
          isAnimationActive={animate}
        >
          <LabelList position="top" offset={10} fill="#1d3540" fontSize={14} fontWeight={800} valueAccessor={lastOnly(games, (g) => `${g.accuracy}%`)} />
        </Line>
      </LineChart>
    </ResponsiveContainer>
  );
}

export function BlundersChart({ games }: { games: GameChartPoint[] }) {
  const animate = !prefersReducedMotion();
  const top = Math.max(3, ...games.map((g) => g.blunders));
  const step = top <= 6 ? 1 : top <= 12 ? 2 : 5;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={games} margin={MARGIN} accessibilityLayer barCategoryGap={2}>
        <CartesianGrid vertical={false} stroke={COLOR.grid} strokeWidth={1} />
        <XAxis dataKey="n" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: COLOR.grid }} interval={tickEvery(games.length)} />
        <YAxis domain={[0, top]} ticks={ticks} allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} />
        <Tooltip content={BlundersTooltip} cursor={{ fill: 'rgba(29, 53, 64, 0.06)' }} />
        <Bar dataKey="blunders" name="Зевки" fill={COLOR.blunders} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={animate} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function RatingChart({ rating }: { rating: RatingChartPoint[] }) {
  const animate = !prefersReducedMotion();
  const domain = niceDomain(rating.map((p) => p.rating));
  const step = domain[1] - domain[0] > 400 ? 100 : 50;
  const ticks = Array.from({ length: Math.floor((domain[1] - domain[0]) / step) + 1 }, (_, i) => domain[0] + i * step);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={rating} margin={MARGIN} accessibilityLayer>
        <CartesianGrid vertical={false} stroke={COLOR.grid} strokeWidth={1} />
        <XAxis dataKey="dateLabel" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: COLOR.grid }} interval="preserveStartEnd" minTickGap={48} />
        <YAxis domain={domain} ticks={ticks} tick={AXIS_TICK} tickLine={false} axisLine={false} width={52} allowDecimals={false} />
        <Tooltip content={RatingTooltip} cursor={{ stroke: COLOR.tick, strokeWidth: 1 }} />
        <Line
          type="linear"
          dataKey="rating"
          name="Рейтинг задач"
          stroke={COLOR.rating}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          dot={rating.length <= 24 ? { r: 4, fill: COLOR.rating, stroke: COLOR.surface, strokeWidth: 2 } : false}
          activeDot={{ r: 7, fill: COLOR.rating, stroke: COLOR.surface, strokeWidth: 2 }}
          isAnimationActive={animate}
        >
          <LabelList position="top" offset={10} fill="#1d3540" fontSize={14} fontWeight={800} valueAccessor={lastOnly(rating, (p) => String(p.rating))} />
        </Line>
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Default export for React.lazy. */
export default function ProgressCharts({ games, rating }: ProgressChartsProps) {
  return (
    <>
      {games.length >= 2 ? (
        <div className={styles.chartPair}>
          <figure className={styles.chart}>
            <figcaption>
              <strong>Точность по партиям</strong>
              <span>чем выше, тем ближе ходы к лучшим</span>
            </figcaption>
            <AccuracyChart games={games} />
          </figure>
          <figure className={styles.chart}>
            <figcaption>
              <strong>Зевки по партиям</strong>
              <span>чем меньше, тем внимательнее игра</span>
            </figcaption>
            <BlundersChart games={games} />
          </figure>
        </div>
      ) : null}
      {rating.length >= 2 ? (
        <figure className={styles.chart}>
          <figcaption>
            <strong>Рейтинг в задачах</strong>
            <span>растёт, когда задачи решаются с первой попытки</span>
          </figcaption>
          <RatingChart rating={rating} />
        </figure>
      ) : null}
    </>
  );
}
