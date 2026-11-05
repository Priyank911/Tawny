import type { CaptureSource } from '../../shared/contracts';
import type { ClefDecisionResult, ClefIntent } from '../providers/cloudflareClef';
import type { Plan } from '../control/actions';
import { parseControlCommand } from './controlGrammar';
import { isExplicitTextQueryRequest, isFastRewriteRequest, isImageGenerationRequest, isTextRewriteRequest, stripFastRewritePrefix } from './intent';

/**
 * Intent routing.
 *
 * Rules, in priority order:
 *  1. Speech that was not addressed to Tawny (no wake phrase, hotkey source)
 *     is plain dictation and never reaches a model. This is the guarantee that
 *     an ordinary sentence cannot turn into an assistant response.
 *  2. Deterministic guardrails win when they match: an explicit image request,
 *     an edit of selected text, an explicit code or answer request, or a
 *     computer-control command the local grammar understands. CLEF then only
 *     chooses the model tier for those.
 *  3. Speech addressed to Tawny that no guardrail matched is classified by
 *     CLEF. A missing or low-confidence answer means dictation, never action.
 */

export interface RouteInput {
  transcript: string;
  source: CaptureSource;
  /** Normalized command after the wake phrase (empty when no wake phrase was spoken). */
  gateRouted: boolean;
  gateCommand: string;
  /** Original-case text after the wake phrase. */
  gateOriginal: string;
  selectedText: string;
}

export type ConsultMode = 'none' | 'tier' | 'classify';

export interface HeuristicRoute {
  /** The command with wake phrase and fast-rewrite prefix removed. */
  command: string;
  fastRewrite: boolean;
  intent: ClefIntent;
  /** A deterministic guardrail chose the intent. */
  matched: boolean;
  control?: Plan;
  consult: ConsultMode;
}

export const CLASSIFY_MIN_CONFIDENCE = 0.75;

export function heuristicRoute(input: RouteInput): HeuristicRoute {
  const initialCommand = (input.gateRouted && input.gateCommand ? input.gateCommand : input.transcript).trim();
  const fastRewrite = Boolean(input.selectedText) && isFastRewriteRequest(initialCommand);
  const command = fastRewrite ? stripFastRewritePrefix(initialCommand) : initialCommand;

  if (fastRewrite) return { command, fastRewrite, intent: 'text_rewrite', matched: true, consult: 'none' };

  // Explicit control verbs come first so "click the update button" is never mistaken for a rewrite.
  if (input.gateRouted && input.gateOriginal) {
    const control = parseControlCommand(input.gateOriginal);
    if (control) return { command, fastRewrite, intent: 'computer_control', matched: true, control, consult: 'none' };
  }

  const image = isImageGenerationRequest(command) || isImageGenerationRequest(input.transcript);
  const rewrite = Boolean(input.selectedText) && isTextRewriteRequest(command);
  const query = !image && !rewrite && isExplicitTextQueryRequest(command);

  if (image) return { command, fastRewrite, intent: 'image_generate', matched: true, consult: 'tier' };
  if (rewrite) return { command, fastRewrite, intent: 'text_rewrite', matched: true, consult: 'tier' };
  if (query) return { command, fastRewrite, intent: 'text_query', matched: true, consult: 'tier' };

  const addressed = input.gateRouted && input.gateCommand.length > 0;
  return { command, fastRewrite, intent: 'plain_dictation', matched: false, consult: addressed ? 'classify' : 'none' };
}

/**
 * Whether a wake-phrase command should capture the user's selection. Capturing
 * means sending Ctrl+C to the focused app, so it is skipped for commands that
 * can never be a rewrite. A grammar-matched control command never needs it.
 */
export function needsSelectionCapture(gateOriginal: string, gateCommand: string): boolean {
  if (!gateCommand) return false;
  if (parseControlCommand(gateOriginal)) return false;
  return isTextRewriteRequest(gateCommand) || isFastRewriteRequest(gateCommand);
}

export interface ResolvedRoute {
  intent: ClefIntent;
  reason: string;
}

export function reconcileIntent(route: HeuristicRoute, decision: ClefDecisionResult | undefined, selectedText: string): ResolvedRoute {
  if (route.matched) return { intent: route.intent, reason: 'guardrail' };
  if (route.consult !== 'classify') return { intent: 'plain_dictation', reason: 'not-addressed' };
  if (!decision || decision.usedFallback) return { intent: 'plain_dictation', reason: 'decider-unavailable' };
  if (decision.confidence < CLASSIFY_MIN_CONFIDENCE) return { intent: 'plain_dictation', reason: 'low-confidence' };
  if (decision.intent === 'text_rewrite' && !selectedText) return { intent: 'plain_dictation', reason: 'nothing-selected' };
  return { intent: decision.intent, reason: 'decider' };
}
