import { Hono } from 'hono';
import type { ConceptCard } from '@gambit/shared';
import type { ServerContext } from '../context.ts';

export function kbRoutes(ctx: ServerContext) {
  return new Hono().get('/:id', (c) => {
    const id = c.req.param('id');
    const card = ctx.content.conceptCards.find((candidate) => candidate.id === id);
    if (card === undefined) return c.json({ error: 'not-found' }, 404);
    return c.json<ConceptCard>(card);
  });
}
