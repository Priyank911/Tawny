import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { pipelineMachine } from '../src/main/pipeline/machine';

function actorAt(...events: Array<Parameters<ReturnType<typeof createActor<typeof pipelineMachine>>['send']>[0]>) {
  const actor = createActor(pipelineMachine);
  actor.start();
  for (const event of events) actor.send(event);
  return actor;
}

describe('pipeline machine', () => {
  it('discards a hands-free job quietly from any pre-handling state', () => {
    for (const events of [
      [{ type: 'HOTKEY' }],
      [{ type: 'HOTKEY' }, { type: 'AUDIO_READY' }],
      [{ type: 'HOTKEY' }, { type: 'AUDIO_READY' }, { type: 'STOP' }],
      [{ type: 'HOTKEY' }, { type: 'AUDIO_READY' }, { type: 'STOP' }, { type: 'STAGE', stage: 'transcribing' }],
      [{ type: 'HOTKEY' }, { type: 'AUDIO_READY' }, { type: 'STOP' }, { type: 'STAGE', stage: 'transcribing' }, { type: 'STAGE', stage: 'gating' }]
    ] as const) {
      const actor = actorAt(...events);
      actor.send({ type: 'DISCARD' });
      expect(actor.getSnapshot().value).toBe('idle');
    }
  });

  it('does not let a discard interrupt work that is already acting on the computer', () => {
    const actor = actorAt({ type: 'HOTKEY' }, { type: 'AUDIO_READY' }, { type: 'STOP' }, { type: 'STAGE', stage: 'transcribing' }, { type: 'STAGE', stage: 'gating' }, { type: 'STAGE', stage: 'handling' });
    actor.send({ type: 'DISCARD' });
    expect(actor.getSnapshot().value).toBe('handling');
  });

  it('moves to confirming and continues only after an explicit confirm', () => {
    const actor = actorAt({ type: 'HOTKEY' }, { type: 'AUDIO_READY' }, { type: 'STOP' }, { type: 'STAGE', stage: 'transcribing' }, { type: 'STAGE', stage: 'gating' }, { type: 'STAGE', stage: 'deciding' }, { type: 'STAGE', stage: 'confirming' });
    expect(actor.getSnapshot().value).toBe('confirming');
    actor.send({ type: 'CONFIRM' });
    expect(actor.getSnapshot().value).toBe('handling');
  });
});
