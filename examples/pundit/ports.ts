/**
 * Integrator ports for the Pundit Shorts pipeline.
 *
 * The SpeckDL machine and the Camel routes compiled from it do not call
 * these. Each Camel action is an HTTP route that accepts a result the
 * integrator already computed (a citation count, a trend-signal string, a
 * Clef score in milli-units). No implementation in this repo performs I/O,
 * and none of these types is a client for Clef, git, ElevenLabs, or YouTube.
 */

export interface Story {
  headline: string;
  sourceUrls: string[];
  facts: string[];
}

export interface Citation {
  /** Locator the Short can show on screen. A take with no citations is not grounded. */
  locator: string;
}

export interface GroundedTake {
  /** Text copied from a source below. Not a generated opinion. */
  text: string;
  citations: Citation[];
}

/**
 * Scott's grounded perspective.
 *
 * An implementation may read his GitHub repositories, his Forgejo
 * repositories, and his Obsidian vault git repo. Return null when those
 * sources do not contain a take on this story. Do not fill that gap with
 * a model opinion. This interface does not clone or fetch anything.
 */
export interface PerspectiveSource {
  lookup(story: Story): Promise<GroundedTake | null>;
}

export interface TrendSignal {
  pattern: string;
  hook: string;
  /** Observed length of the pattern's Shorts, in seconds. */
  lengthSeconds: number;
  topic: string;
}

/**
 * Pluggable input: what is performing well on YouTube Shorts right now.
 * The machine only sees the string passed to DraftScript.
 */
export interface TrendSignals {
  current(): Promise<TrendSignal[]>;
}

/**
 * Quality score from Cloudflare Workers AI Clef.
 *
 * The published binding (not invoked by this repo) is
 * POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef
 * with a Workers AI API token. Documented at https://clefdecide.com/clef-api
 *
 * Use a noul question. `noul` is the probability of yes, from 0 to 1.
 * The pipeline passes iff that probability is >= 0.8.
 */
export interface ClefQualityScore {
  noul: number;
}

export interface ClefEvaluator {
  /**
   * Judge the script against the recorded take: clearly an opinion, sources
   * cited, no fabricated quotes, no defamation. Map the result with scoreMilli.
   */
  scoreScript(script: string, take: GroundedTake): Promise<ClefQualityScore>;
}

/** Pass threshold on the milli scale. 800 means noul >= 0.8. */
export const CLEF_PASS_MILLI = 800;

/**
 * How many below-threshold Clef results may return to scripting.
 * The next one is a terminal failure. Matches Pundit.speckdl `retries < 3`.
 */
export const CLEF_MAX_RETRIES = 3;

/** round(noul * 1000). Throws when noul is outside [0, 1]. */
export function scoreMilli(score: ClefQualityScore): number {
  if (!Number.isFinite(score.noul) || score.noul < 0 || score.noul > 1) {
    throw new Error('Clef noul must be a finite number from 0 to 1');
  }
  return Math.round(score.noul * 1000);
}

export type ClefDecision = 'pass' | 'retry' | 'fail';

/**
 * Which Pundit action to call. The speck cannot guard on scoreMilli:
 * the Z3 backend drops a guard that names an action parameter and then
 * will not treat the approval invariant as a proof. This function is
 * the compare. The generated passClef route does not repeat it.
 */
export function clefDecision(score: ClefQualityScore, retries: number): ClefDecision {
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error('retries must be a non-negative integer');
  }
  if (scoreMilli(score) >= CLEF_PASS_MILLI) return 'pass';
  if (retries >= CLEF_MAX_RETRIES) return 'fail';
  return 'retry';
}

export type PerspectiveDecision = 'record' | 'skip';

/**
 * Record only a take that carries at least one non-empty citation.
 * Otherwise skip. Do not invent a take to turn skip into record.
 */
export function perspectiveDecision(take: GroundedTake | null): PerspectiveDecision {
  if (!take) return 'skip';
  const cited = take.citations.filter(c => c.locator.trim() !== '');
  if (cited.length === 0 || cited.length !== take.citations.length) return 'skip';
  if (take.text.trim() === '') return 'skip';
  return 'record';
}

/**
 * ElevenLabs voice. This repo does not store a voice id.
 * The integrator resolves the voice whose name is SCOTT_VOICE_NAME.
 */
export const SCOTT_VOICE_NAME = 'Scott Scoble';

export interface ShortRenderRequest {
  script: string;
  voiceName: typeof SCOTT_VOICE_NAME;
  aspect: '9:16';
  captions: true;
  /** Locators from the grounded take, shown on screen. */
  sourceCredit: string[];
}

/**
 * YouTube Data API field the integrator sets true on videos.insert or
 * videos.update. This repo does not call YouTube.
 * https://developers.google.com/youtube/v3/docs/videos#status.containsSyntheticMedia
 */
export const YOUTUBE_CONTAINS_SYNTHETIC_MEDIA = 'status.containsSyntheticMedia';
