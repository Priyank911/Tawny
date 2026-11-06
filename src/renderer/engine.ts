import { CaptureCore, FRAME_SAMPLES, SAMPLE_RATE, type SessionClip } from '../shared/audio/captureCore';

/**
 * Hidden always-on microphone engine for hands-free mode. It never sends audio
 * anywhere by itself: it keeps a short rolling buffer in memory and, when the
 * main process says the wake phrase was heard, returns that stretch of audio
 * as one clip once the person has finished speaking.
 */

export interface EngineCommand {
  type: 'start' | 'stop' | 'begin' | 'end';
  reason?: 'send_it' | 'recognizer' | 'cancelled';
}

export interface EngineBridge {
  onCommand(listener: (command: EngineCommand) => void): void;
  status(status: { state: 'running' | 'stopped' | 'error'; message?: string }): void;
  rms(value: number): void;
  clip(clip: { pcm: Uint8Array; reason: SessionClip['reason']; commandVoicedMs: number; durationMs: number; noiseFloor: number; peakRms: number }): void;
}

declare global {
  interface Window {
    engineBridge: EngineBridge;
  }
}

const WORKLET_SOURCE = `
class TawnyFrames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(${FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.frame[this.filled] = sample < 0 ? sample * 32768 : sample * 32767;
      this.filled += 1;
      if (this.filled === ${FRAME_SAMPLES}) {
        const copy = this.frame.slice();
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('tawny-frames', TawnyFrames);
`;

const bridge = window.engineBridge;
let context: AudioContext | undefined;
let stream: MediaStream | undefined;
let core: CaptureCore | undefined;

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Microphone access is blocked. Allow desktop apps to use the microphone in Windows privacy settings.';
    if (error.name === 'NotFoundError') return 'No microphone was found.';
    if (error.name === 'NotReadableError') return 'The microphone is in use by another program.';
  }
  return error instanceof Error ? error.message : 'The microphone could not be started.';
}

async function start(): Promise<void> {
  if (context) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Gain control matches the shortcut recorder: without it a laptop microphone is often too quiet for the
      // voice detector, and the command after "Hey Tawny" is never heard.
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    if (context.sampleRate !== SAMPLE_RATE) throw new Error(`The audio device does not support ${SAMPLE_RATE} Hz capture.`);
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    core = new CaptureCore({
      onRms: (value) => bridge.rms(value),
      onSessionEnd: (clip) => {
        bridge.clip({
          pcm: new Uint8Array(clip.samples.buffer, clip.samples.byteOffset, clip.samples.byteLength),
          reason: clip.reason,
          commandVoicedMs: clip.commandVoicedMs,
          durationMs: clip.durationMs,
          noiseFloor: clip.noiseFloor,
          peakRms: clip.peakRms
        });
      }
    });
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'tawny-frames', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => core?.pushFrame(new Int16Array(event.data));
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(node);
    node.connect(silent);
    silent.connect(context.destination);
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      void stop();
      bridge.status({ state: 'error', message: 'The microphone was disconnected.' });
    });
    bridge.status({ state: 'running' });
  } catch (error) {
    await stop();
    bridge.status({ state: 'error', message: describeError(error) });
  }
}

async function stop(): Promise<void> {
  core = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  const closing = context;
  context = undefined;
  if (closing && closing.state !== 'closed') await closing.close().catch(() => undefined);
}

bridge.onCommand((command) => {
  if (command.type === 'start') void start();
  else if (command.type === 'stop') void stop().then(() => bridge.status({ state: 'stopped' }));
  else if (command.type === 'begin') core?.beginSession();
  else if (command.type === 'end') core?.endSession(command.reason ?? 'cancelled');
});
