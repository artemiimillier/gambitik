/**
 * «Все партии» of the progress screen: every game page by page (→ its review). A game that does not count in the
 * child's progress says why («играл взрослый», «в архиве»). With the parent gate open each game also gets
 * «Это играл взрослый» / «Вернуть в прогресс» and «Журнал».
 */
import type { ReactNode } from 'react';
import { getPersona } from '@gambit/content';
import { TIME_CONTROLS } from '@gambit/shared';
import type { GameListItem } from '@gambit/shared';
import { Badge, Button, Card, Icon, PersonaAvatar, Spinner, pluralRu } from '../../ui/index.ts';
import { EXCLUSION_LABEL, exclusionOf } from './gamesModel.ts';
import { OUTCOME_LABEL, formatDateTimeRu, outcomeFor } from './progressModel.ts';
import styles from './ProgressScreen.module.css';

const OUTCOME_TONE = { win: 'green', loss: 'neutral', draw: 'blue', unfinished: 'neutral' } as const;
const REVIEW_LABEL: Record<GameListItem['reviewStatus'], string> = { pending: 'разбор готовится', ready: 'разбор готов', template: 'разбор готов', failed: 'короткий разбор' };

/**
 * The server adds `judgedMoves` to every list row (additive to the contract): a game the engine never
 * looked at is stored with accuracy 0, which must not be shown as «точность 0 %». An older server sends no field → judged.
 */
export function wasJudged(game: GameListItem): boolean {
  const judged = (game as GameListItem & { judgedMoves?: unknown }).judgedMoves;
  return typeof judged !== 'number' || judged > 0;
}

export interface GamesCardProps {
  games: readonly GameListItem[];
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onLoadMore(): void;
  onOpenGame(gameId: string): void;
  /** the parent gate is open: marks and journals */
  parent: boolean;
  /** a mark being saved right now */
  busyGameId: string | null;
  onToggleAdult(game: GameListItem): void;
  onOpenJournal(game: GameListItem): void;
  /** below the list: the way into the parent's tools, or the tools themselves */
  footer?: ReactNode;
}

export function GamesCard({ games, hasMore, loadingMore, moreFailed, onLoadMore, onOpenGame, parent, busyGameId, onToggleAdult, onOpenJournal, footer }: GamesCardProps) {
  const countText = games.length > 0 ? `${games.length} ${pluralRu(games.length, 'партия', 'партии', 'партий')}${hasMore ? ' и ещё' : ''}` : null;
  return (
    <Card padding="lg" as="section" title="Все партии" headerAside={countText !== null ? <span className={styles.gamesCount}>{countText}</span> : undefined}>
      {games.length === 0 ? <p className={styles.empty}>Партий пока нет.</p> : null}
      <ul className={styles.games}>
        {games.map((game) => {
          const persona = getPersona(game.personaId);
          const outcome = outcomeFor(game.result, game.childColor);
          const excluded = exclusionOf(game);
          const who = `${persona?.name ?? 'соперник'}, ${formatDateTimeRu(game.startedAt)}`;
          return (
            <li key={game.id} className={styles.game} data-excluded={excluded !== null ? 'true' : 'false'}>
              {persona ? <PersonaAvatar persona={persona} size={56} /> : null}
              <div className={styles.gameText}>
                <p className={styles.gameTitle}>
                  {persona ? persona.name : 'Соперник'} <Badge tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>
                  {excluded !== null ? (
                    <Badge tone="sunny" size="sm">
                      {EXCLUSION_LABEL[excluded]} — не в успехах
                    </Badge>
                  ) : null}
                </p>
                <p className={styles.gameMeta}>
                  {formatDateTimeRu(game.startedAt)} · {TIME_CONTROLS[game.timeControlId].label} ·{' '}
                  {wasJudged(game) ? (
                    <>
                      точность {Math.round(game.accuracy)}% · {game.blunders} {pluralRu(game.blunders, 'зевок', 'зевка', 'зевков')}
                    </>
                  ) : (
                    'ходы не проверялись'
                  )}{' '}
                  · {REVIEW_LABEL[game.reviewStatus]}
                </p>
                {parent ? (
                  <div className={styles.gameParent}>
                    <Button variant="ghost" size="md" disabled={busyGameId !== null} onClick={() => onToggleAdult(game)} aria-label={excluded !== null ? `Вернуть в прогресс: ${who}` : `Это играл взрослый: ${who}`}>
                      {busyGameId === game.id ? 'Сохраняю…' : excluded !== null ? 'Вернуть в прогресс' : 'Это играл взрослый'}
                    </Button>
                    <Button variant="ghost" size="md" onClick={() => onOpenJournal(game)} aria-label={`Журнал партии: ${who}`}>
                      Журнал
                    </Button>
                  </div>
                ) : null}
              </div>
              <Button variant="secondary" size="md" iconAfter={<Icon name="forward" />} onClick={() => onOpenGame(game.id)} aria-label={`Разбор партии: ${who}`}>
                Разбор
              </Button>
            </li>
          );
        })}
      </ul>
      {hasMore || loadingMore || moreFailed ? (
        <div className={styles.more}>
          {loadingMore ? (
            <Spinner size={32} label="Загружаю партии…" showLabel />
          ) : (
            <Button variant="secondary" size="md" icon={moreFailed ? <Icon name="refresh" /> : undefined} onClick={onLoadMore}>
              {moreFailed ? 'Не получилось — попробовать ещё' : 'Показать ещё'}
            </Button>
          )}
        </div>
      ) : null}
      {footer}
    </Card>
  );
}
