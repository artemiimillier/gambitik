import { Hono } from 'hono';
import type { CurriculumStage } from '@gambit/shared';
import { stageFor } from '../content.ts';
import type { ServerContext } from '../context.ts';

export function curriculumRoutes(ctx: ServerContext) {
  return new Hono().get('/', (c) => {
    const current = stageFor(ctx.content.curriculum, ctx.student.getProfile().stage).stage;
    return c.json<{ stages: CurriculumStage[]; current: number }>({ stages: ctx.content.curriculum, current });
  });
}
