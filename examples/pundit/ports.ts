/**
 * Integrator ports for the Pundit Shorts pipeline.
 *
 * The SpeckDL machine and the Camel routes compiled from it do not call
 * these. Each Camel action is an HTTP route that accepts a result the
 * integrator already computed (a citation count, a trend-signal string, a
 * Clef score in milli-units). No implementation in this repo performs I/O.
 * Clef's request is the Ollama Cloud System One POST in this file
 * (CLEF_URL, model CLEF_MODEL, Bearer OLLAMA_API_KEY). This file builds
 * that request and reads answers.passes.noul. It does not send it.
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
 * Ollama Cloud System One. Direct call, model `clef`.
 * https://docs.ollama.com/capabilities/decision
 */
export const CLEF_URL = 'https://ollama.com/v1/systemone';

/** Model name when calling ollama.com directly. `clef:cloud` is the local-server alias. */
export const CLEF_MODEL = 'clef';

/** Bearer token for CLEF_URL. This module does not read the environment. */
export const CLEF_API_KEY_ENV = 'OLLAMA_API_KEY';

/** Named noul question. The answer is `answers.passes.noul`. */
export const CLEF_QUESTION = 'passes';

/**
 * Quality score from a Clef noul answer.
 * `noul` is the probability of yes, from 0 to 1.
 * The pipeline passes iff that probability is >= 0.8.
 */
export interface ClefQualityScore {
  noul: number;
}

export interface ClefSystemOneRequest {
  url: typeof CLEF_URL;
  method: 'POST';
  headers: {
    Authorization: string;
    'Content-Type': 'application/json';
  };
  body: {
    model: typeof CLEF_MODEL;
    state: { script: string; take: GroundedTake };
    questions: {
      passes: {
        type: 'noul';
        instructions: string;
        criteria: { true: string; false: string };
      };
    };
  };
}

/**
 * POST body for Ollama Cloud. `apiKey` is the OLLAMA_API_KEY value.
 * The caller sends the request. This function does not.
 *
 * Documented response shape: `answers.passes.noul` is the probability
 * of the true criterion, from 0 to 1. Read it with noulFromSystemOne.
 */
export function clefSystemOneRequest(apiKey: string, script: string, take: GroundedTake): ClefSystemOneRequest {
  if (apiKey.trim() === '') {
    throw new Error('OLLAMA_API_KEY is required');
  }
  return {
    url: CLEF_URL,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: CLEF_MODEL,
      state: { script, take },
      questions: {
        passes: {
          type: 'noul',
          instructions: 'Is this Short clearly an opinion, with its sources cited, with no words attributed to a real person, and with no defamation?',
          criteria: {
            true: 'The script is clearly an opinion, cites its sources, does not attribute words to a real person, and does not defame.',
            false: 'The script is missing one of those properties.',
          },
        },
      },
    },
  };
}

/** Read `answers.passes.noul` from a System One response. */
export function noulFromSystemOne(payload: unknown): ClefQualityScore {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Clef response is missing answers.passes.noul');
  }
  const answers = (payload as { answers?: unknown }).answers;
  const answer = answers && typeof answers === 'object'
    ? (answers as Record<string, { noul?: unknown }>)[CLEF_QUESTION]
    : undefined;
  const noul = answer?.noul;
  if (typeof noul !== 'number') {
    throw new Error('Clef response is missing answers.passes.noul');
  }
  return { noul };
}

export interface ClefEvaluator {
  /**
   * POST clefSystemOneRequest to CLEF_URL with OLLAMA_API_KEY, then
   * noulFromSystemOne. Map that score with clefDecision. This interface
   * does not perform the POST.
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
  /** Locators from the grounded take, shown on screen. Not an AI-voiced label. */
  sourceCredit: string[];
}

/**
 * YouTube Data API field the integrator sets true on videos.insert or
 * videos.update. This is the only synthetic-media disclosure. The Short
 * does not carry an on-screen AI-voiced label. This repo does not call YouTube.
 * https://developers.google.com/youtube/v3/docs/videos#status.containsSyntheticMedia
 */
export const YOUTUBE_CONTAINS_SYNTHETIC_MEDIA = 'status.containsSyntheticMedia';
