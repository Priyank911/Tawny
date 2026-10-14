import type { OverlaySnapshot, PipelineLog, ProviderSettings } from '../shared/contracts';

declare module '*.css';

declare global {
  interface Window {
    voiceRouter: {
      getSnapshot: () => Promise<OverlaySnapshot>;
      getLogs: () => Promise<PipelineLog[]>;
      onLog: (listener: (entry: PipelineLog) => void) => () => void;
      getSettings: () => Promise<ProviderSettings>;
      saveSettings: (settings: ProviderSettings) => Promise<void>;
      generateImage: (prompt: string) => Promise<{ base64: string; mimeType: 'image/jpeg' }>;
      transcribeAudio: (audio: Uint8Array) => Promise<string>;
      logCapture: (input: { event: string; message: string; level?: 'debug' | 'info' | 'warn' | 'error'; data?: Record<string, string> }) => void;
      onOpenSettings: (listener: () => void) => () => void;
      onOpenLogs: (listener: () => void) => () => void;
      enterBackground: () => Promise<void>;
      onBackgroundMode: (listener: () => void) => () => void;
      send: (event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => void;
      subscribe: (listener: (snapshot: OverlaySnapshot) => void) => () => void;
    };
  }
}

export {};
