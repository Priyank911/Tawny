import type { Action, Decision } from '../../shared/contracts';

export interface PolicyThresholds {
  minimumConfidence: number;
  confirmBelow: number;
  minimumRequest: number;
  runConfidence: number;
  runRequest: number;
}

export const defaultThresholds: PolicyThresholds = {
  minimumConfidence: 0.5,
  confirmBelow: 0.8,
  minimumRequest: 0.4,
  runConfidence: 0.8,
  runRequest: 0.7
};

export function chooseAction(
  decision: Decision,
  thresholds: PolicyThresholds = defaultThresholds,
  providerDisagrees = false
): Action {
  if (decision.confidence < thresholds.minimumConfidence || decision.isRequest < thresholds.minimumRequest) {
    return { type: 'dictate' };
  }
  if (decision.intent === 'image_generate') {
    if (
      !providerDisagrees &&
      decision.confidence >= thresholds.runConfidence &&
      decision.isRequest >= thresholds.runRequest
    ) {
      return { type: 'run', intent: decision.intent };
    }
    if (decision.confidence < thresholds.confirmBelow || providerDisagrees) {
      return { type: 'confirm', intent: decision.intent, timeoutMs: 3000 };
    }
    return { type: 'run', intent: decision.intent };
  }
  return { type: 'dictate' };
}
