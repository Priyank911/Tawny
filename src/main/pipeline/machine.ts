import { assign, createMachine } from 'xstate';
import type { OverlayState } from '../../shared/contracts';

export interface PipelineContext {
  state: OverlayState;
  message?: string;
  rms: number;
  elapsedMs: number;
}

export type PipelineEvent =
  | { type: 'HOTKEY' }
  | { type: 'AUDIO_READY' }
  | { type: 'STOP' }
  | { type: 'CANCEL' }
  | { type: 'STAGE'; stage: OverlayState }
  | { type: 'CONFIRM' }
  | { type: 'SUCCESS'; message?: string }
  | { type: 'FAIL'; message: string };

export const pipelineMachine = createMachine({
  types: {} as { context: PipelineContext; events: PipelineEvent },
  id: 'voiceRouter',
  initial: 'idle',
  context: { state: 'idle', rms: 0, elapsedMs: 0 },
  states: {
    idle: { on: { HOTKEY: 'arming' } },
    arming: { on: { AUDIO_READY: 'recording', CANCEL: 'cancelled' } },
    recording: { on: { STOP: 'finalizing', CANCEL: 'cancelled' } },
    finalizing: { on: { STAGE: { target: 'transcribing' }, CANCEL: 'cancelled', FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) } } },
    transcribing: { on: { STAGE: { target: 'gating' }, FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) }, CANCEL: 'cancelled' } },
    gating: { on: { STAGE: { target: 'deciding' }, SUCCESS: 'done', FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) }, CANCEL: 'cancelled' } },
    deciding: { on: { STAGE: { target: 'confirming' }, SUCCESS: 'done', FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) }, CANCEL: 'cancelled' } },
    confirming: { on: { CONFIRM: 'handling', HOTKEY: 'handling', CANCEL: 'cancelled' } },
    handling: { on: { STAGE: { target: 'injecting' }, FAIL: 'failed', CANCEL: 'cancelled' } },
    injecting: { on: { SUCCESS: 'done', FAIL: 'failed', CANCEL: 'cancelled' } },
    done: { after: { 5000: 'idle' }, on: { HOTKEY: 'arming' } },
    failed: { after: { 6000: 'idle' }, on: { HOTKEY: 'arming' } },
    cancelled: { after: { 250: 'idle' } }
  }
});

export function overlayState(value: string): OverlayState {
  const allowed: OverlayState[] = ['idle', 'arming', 'recording', 'finalizing', 'transcribing', 'gating', 'deciding', 'confirming', 'handling', 'injecting', 'done', 'failed', 'cancelled'];
  return allowed.includes(value as OverlayState) ? value as OverlayState : 'idle';
}
