/** Student profile persistence (kv table) + the manual updates of `PUT /student`. */
import type { StudentProfile } from '@gambit/shared';
import type { ContentBundle } from '../content.ts';
import { studentProfileSchema } from '../schemas.ts';
import type { StudentUpdateInput } from '../schemas.ts';
import type { Repo } from '../storage/repo.ts';
import { defaultProfile } from './profile.ts';

export class StudentService {
  private readonly repo: Repo;
  private readonly content: Pick<ContentBundle, 'curriculum'>;

  constructor(repo: Repo, content: Pick<ContentBundle, 'curriculum'>) {
    this.repo = repo;
    this.content = content;
  }

  /**
   * The stored profile; created with defaults on first use. A stored profile that no longer
   * validates (older schema, manual edit) is repaired field by field from the defaults — and the
   * original is kept under a backup key — rather than being thrown away.
   */
  getProfile(): StudentProfile {
    const raw = this.repo.loadProfileRaw();
    const stored = studentProfileSchema.safeParse(raw);
    if (stored.success) return stored.data;

    const fresh = defaultProfile();
    if (raw === undefined) {
      this.repo.saveProfile(fresh);
      return fresh;
    }
    this.repo.backupProfile(raw, new Date().toISOString());
    const repaired: Record<string, unknown> = { ...fresh };
    if (typeof raw === 'object' && raw !== null) {
      for (const [key, value] of Object.entries(raw)) {
        const candidate = studentProfileSchema.safeParse({ ...repaired, [key]: value });
        if (candidate.success) repaired[key] = value;
      }
    }
    const profile = studentProfileSchema.parse(repaired);
    this.repo.saveProfile(profile);
    return profile;
  }

  saveProfile(profile: StudentProfile): void {
    this.repo.saveProfile(profile);
  }

  private clampStage(stage: number): number {
    const stages = this.content.curriculum.map((s) => s.stage);
    return Math.min(Math.max(stage, Math.min(...stages)), Math.max(...stages));
  }

  /** Manual edit by the parent / settings screen. A manual stage change may go down as well as up. */
  update(patch: StudentUpdateInput): StudentProfile {
    return this.repo.tx(() => {
      const current = this.getProfile();
      const next: StudentProfile = { ...current, updatedAt: new Date().toISOString() };
      if (patch.nickname !== undefined) next.nickname = patch.nickname;
      if (patch.address !== undefined) next.address = patch.address;
      if (patch.stage !== undefined) {
        const stage = this.clampStage(patch.stage);
        if (stage !== current.stage) {
          next.stage = stage;
          // mastery of the new stage is measured on games played from now on
          this.repo.saveStageMeta({ gamesAtStageStart: current.totals.games, stageStartedAt: next.updatedAt });
        }
      }
      this.repo.saveProfile(next);
      return next;
    });
  }
}
