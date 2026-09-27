/**
 * «Дозапись голоса»: the ONLY server file that imports the voice-clip tools (`tools/voice-clips/*`) — a test enforces
 * it (voiceGen/guards.test.ts). The paid protocol (intent → create → wait → download), the ledger and its budget
 * arithmetic, the prices and the ids have ONE implementation, covered by the tools' own tests; the server reuses it
 * instead of a copy that could drift. Everything re-exported here is free of side effects on import (the tools'
 * `config.ts` only computes paths). Moving the tools into a workspace package later is a mechanical change of this file.
 */
export {
  ABSENT_AFTER_CHECKS,
  GLOBAL_LOCK,
  MAX_PAID_ATTEMPTS,
  ONDEMAND_CAMPAIGN,
  ONDEMAND_TAKE_BASE,
  OVERLAY_LEDGER,
  PREFETCH_CAMPAIGN,
  adoptIntents,
  createJob,
  downloadJob,
  isAuthProblem,
  isNoCredits,
  localDay,
  lockGlobal,
  onDemandViewOf,
  readOnDemandLedger,
  spentByDay,
  unitAttempts,
  waitArgs,
} from '../../../../tools/voice-clips/ondemand.ts';
export type {
  AdoptIntentsInput,
  AdoptSummary,
  CreateJobInput,
  CreateOutcome,
  DownloadJobInput,
  IntentLine,
  OnDemandDeps,
  OnDemandLine,
  OnDemandView,
} from '../../../../tools/voice-clips/ondemand.ts';
export { LedgerLocked, appendLedger, auditBlocked, lockLedger, readLedger, tryLock } from '../../../../tools/voice-clips/ledger.ts';
export type { LedgerJob, LedgerLine, LedgerView } from '../../../../tools/voice-clips/ledger.ts';
export { CliError, DONE_FAILED, DONE_OK, isRateLimited, isTransient, modelProblem, parseJobs, serverCostMilli } from '../../../../tools/voice-clips/higgsfield.ts';
export type { CliResult, HfJob, RunCli } from '../../../../tools/voice-clips/higgsfield.ts';
export { jobMilli, promptProblem } from '../../../../tools/voice-clips/cost.ts';
export { CLIP_ID_RE, clipId } from '../../../../tools/voice-clips/ids.ts';
export { isDiscard, keyOfJob } from '../../../../tools/voice-clips/jobs.ts';
export type { GenJob, Piece, UnitPiece } from '../../../../tools/voice-clips/jobs.ts';
export { readCurrentManifest, readStore, readVerdicts } from '../../../../tools/voice-clips/manifest.ts';
export type { Manifest, UnitStore, Verdicts } from '../../../../tools/voice-clips/manifest.ts';
export { DEFAULT_WHISPER_MODEL, PUBLISH_LOCK, VOICE_KEY, WHISPER_BIN, WHISPER_MODEL } from '../../../../tools/voice-clips/config.ts';
// where the overlay may live: ONE rule for the server's config and the owner's tools
export { overlayDirProblem, realish } from '../../../../tools/voice-clips/placement.ts';
export type { OverlayDirProblem } from '../../../../tools/voice-clips/placement.ts';
// the overlay's publishing rule: which takes a check really turned down, which words a key names today, its twins
export { alsoKeysOf, currentTextOfKey, isToolFailureFlag, overlayCheckOf } from '../../../../tools/voice-clips/overlay.ts';
export { backoffMs, looksLikeMp3 } from '../../../../tools/voice-clips/generate.ts';
export type { DownloadResult } from '../../../../tools/voice-clips/generate.ts';
// the finish's two steps: production runs them as children (runner.ts `createToolsFinish`, the tools' CLI); the
// end-to-end test runs the same functions in-process with a fake recogniser (whisper cannot hear a synthetic tone)
export { ffmpegAvailable } from '../../../../tools/voice-clips/audio.ts';
export { runProcess } from '../../../../tools/voice-clips/process.ts';
export { runVerify } from '../../../../tools/voice-clips/verify.ts';
