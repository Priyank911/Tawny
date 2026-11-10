import { z } from 'zod';

export const stageSchema = z.enum(['capture', 'stt', 'gate', 'decide', 'handle', 'inject']);
export type Stage = z.infer<typeof stageSchema>;

export const errorClassSchema = z.enum(['transient', 'permanent', 'input', 'environment', 'cancelled']);
export type ErrorClass = z.infer<typeof errorClassSchema>;

export class PipelineError extends Error {
  readonly name = 'PipelineError';
  constructor(
    public readonly cls: ErrorClass,
    public readonly stage: Stage,
    public readonly userMessage: string,
    public readonly retryAfterMs?: number
  ) {
    super(userMessage);
  }
}

export const overlayStateSchema = z.enum([
  'idle', 'arming', 'recording', 'finalizing', 'transcribing', 'gating',
  'deciding', 'confirming', 'handling', 'injecting', 'done', 'failed', 'cancelled'
]);
export type OverlayState = z.infer<typeof overlayStateSchema>;

export const decisionSchema = z.object({
  intent: z.enum(['image_generate', 'plain_text', 'other_task']),
  probs: z.record(z.string(), z.number().min(0).max(1)),
  confidence: z.number().min(0).max(1),
  isRequest: z.number().min(0).max(1),
  decidedBy: z.string(),
  latencyMs: z.number().nonnegative()
});
export type Decision = z.infer<typeof decisionSchema>;

export const targetWindowSchema = z.object({
  hwnd: z.string(),
  pid: z.number().int().nonnegative(),
  exe: z.string(),
  title: z.string(),
  elevated: z.boolean(),
  monitorId: z.number().int()
});
export type TargetWindow = z.infer<typeof targetWindowSchema>;

export const intentSchema = z.enum(['image_generate', 'text_rewrite', 'text_query', 'computer_control', 'plain_dictation']);
export type Intent = z.infer<typeof intentSchema>;

export const captureSourceSchema = z.enum(['hotkey', 'wake']);
export type CaptureSource = z.infer<typeof captureSourceSchema>;

export const overlaySnapshotSchema = z.object({
  state: overlayStateSchema,
  stage: stageSchema.optional(),
  elapsedMs: z.number().nonnegative().default(0),
  rms: z.number().min(0).max(1).default(0),
  message: z.string().optional(),
  imageDataUrl: z.string().optional(),
  target: targetWindowSchema.optional(),
  intent: intentSchema.optional(),
  source: captureSourceSchema.optional(),
  confirmMessage: z.string().optional()
});
export type OverlaySnapshot = z.infer<typeof overlaySnapshotSchema>;

export interface ProviderContext {
  signal: AbortSignal;
  deadline: number;
  jobId: string;
}

export interface Provider<I, O> {
  readonly name: string;
  run(input: I, context: ProviderContext): Promise<O>;
}

export type Action =
  | { type: 'dictate' }
  | { type: 'confirm'; intent: string; timeoutMs: number }
  | { type: 'run'; intent: string };

export const providerSettingsSchema = z.object({
  groqApiKey: z.string().default(''),
  cloudflareAccountId: z.string().default(''),
  cloudflareApiToken: z.string().default('')
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

export const behaviorSettingsSchema = z.object({
  handsFree: z.boolean().default(false),
  controlStyle: z.enum(['visual', 'fast']).default('visual'),
  visionFallback: z.boolean().default(false)
});
export type BehaviorSettings = z.infer<typeof behaviorSettingsSchema>;

export type HandsFreeState = 'off' | 'starting' | 'listening' | 'paused' | 'error';

export interface HandsFreeStatus {
  enabled: boolean;
  state: HandsFreeState;
  message: string;
}

export interface AuthProfile {
  email: string;
  displayName: string;
  photoUrl?: string;
}

export interface UpdateNotice {
  state: 'available' | 'downloading' | 'ready' | 'manual' | 'error';
  version?: string;
  message: string;
}

export interface HotkeyStatus {
  accelerator: string;
  registered: boolean;
  wayland: boolean;
  compositorCommand?: string;
  message: string;
}

export interface HotkeyTestResult {
  success: boolean;
  message: string;
}

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const pipelineLogSchema = z.object({
  timestamp: z.string(),
  level: logLevelSchema,
  event: z.string(),
  message: z.string(),
  jobId: z.string().optional(),
  stage: stageSchema.optional(),
  provider: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  errorClass: errorClassSchema.optional(),
  data: z.record(z.string(), z.string()).optional()
});
export type PipelineLog = z.infer<typeof pipelineLogSchema>;

export const fluxImageResponseSchema = z.object({
  image: z.string().min(1)
});

export const cloudflareEnvelopeSchema = z.object({
  result: fluxImageResponseSchema,
  success: z.boolean(),
  errors: z.array(z.unknown()).default([]),
  messages: z.array(z.unknown()).default([])
});

/** A failed request whose audio is kept (encrypted) so it can be transcribed again. */
export interface RecoveryRecording {
  id: string;
  createdAt: string;
  source: CaptureSource;
  mimeType: string;
  bytes: number;
  durationMs: number;
  /** Why the original request failed. */
  reason: string;
  stage: string;
  status: 'pending' | 'working' | 'waiting' | 'failed' | 'transcribed';
  attempts: number;
  hasAudio: boolean;
  transcript?: string;
  /** Latest retry failure, or why it is waiting. */
  lastError?: string;
  /** ISO time before which Groq should not be asked again. */
  retryAfter?: string;
}

export interface RecoveryState {
  available: boolean;
  recordings: RecoveryRecording[];
  budget: {
    requestsLastMinute: number;
    requestsToday: number;
    audioSecondsLastHour: number;
    audioSecondsToday: number;
    limits: { requestsPerMinute: number; requestsPerDay: number; audioSecondsPerHour: number; audioSecondsPerDay: number };
  };
}

/** One finished request, for the Home page's recent list. No transcript text. */
export interface JobHistoryEntry {
  jobId: string;
  at: string;
  source: CaptureSource;
  intent?: Intent;
  outcome: 'done' | 'failed';
  message: string;
  savedRecording?: boolean;
}
