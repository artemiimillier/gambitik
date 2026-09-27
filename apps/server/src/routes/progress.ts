import { Hono } from 'hono';
import type { ProgressSnapshot } from '@gambit/shared';
import type { ServerContext } from '../context.ts';
import { buildProgressSnapshot } from '../services/progress.ts';

export function progressRoutes(ctx: ServerContext) {
  return new Hono().get('/', (c) => c.json<ProgressSnapshot>(buildProgressSnapshot(ctx.repo, ctx.student.getProfile(), ctx.content)));
}
