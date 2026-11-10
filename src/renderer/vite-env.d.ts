import type { AuthProfile, BehaviorSettings, HandsFreeStatus, HotkeyStatus, HotkeyTestResult, JobHistoryEntry, OverlaySnapshot, PipelineLog, ProviderSettings, RecoveryState, UpdateNotice } from '../shared/contracts';

declare module '*.css';

declare global {
  interface Window {
    voiceRouter: {
      getSnapshot: () => Promise<OverlaySnapshot>;
      getLogs: () => Promise<PipelineLog[]>;
      onLog: (listener: (entry: PipelineLog) => void) => () => void;
      openLogsFolder: () => Promise<void>;
      getHistory: () => Promise<JobHistoryEntry[]>;
      onHistory: (listener: (history: JobHistoryEntry[]) => void) => () => void;
      getAppInfo: () => Promise<{ version: string; platform: string }>;
      windowAction: (action: 'minimize' | 'hide') => Promise<void>;
      getRecovery: () => Promise<RecoveryState>;
      onRecovery: (listener: (state: RecoveryState) => void) => () => void;
      retryRecording: (id?: string) => Promise<void>;
      removeRecording: (id: string) => Promise<void>;
      clearRecordings: () => Promise<void>;
      copyRecording: (id: string) => Promise<void>;
      getSettings: () => Promise<ProviderSettings>;
      closeSettings: () => Promise<void>;
      setSettingsOpen: (open: boolean) => void;
      saveSettings: (settings: ProviderSettings) => Promise<void>;
      getHotkey: () => Promise<HotkeyStatus>;
      setHotkeyCaptureMode: (enabled: boolean) => Promise<void>;
      saveHotkey: (accelerator: string) => Promise<HotkeyStatus>;
      testHotkey: () => Promise<HotkeyTestResult>;
      copyCompositorCommand: () => Promise<void>;
      generateImage: (prompt: string) => Promise<{ base64: string; mimeType: 'image/jpeg' }>;
      transcribeAudio: (audio: Uint8Array | Uint8Array[]) => Promise<string>;
      logCapture: (input: { event: string; message: string; level?: 'debug' | 'info' | 'warn' | 'error'; data?: Record<string, string> }) => void;
      onOpenSettings: (listener: () => void) => () => void;
      onOpenLogs: (listener: () => void) => () => void;
      enterBackground: () => Promise<void>;
      onBackgroundMode: (listener: () => void) => () => void;
      getAuthProfile: () => Promise<AuthProfile | undefined>;
      signIn: () => Promise<AuthProfile>;
      cancelSignIn: () => Promise<void>;
      signOut: () => Promise<void>;
      onAuthProfile: (listener: (profile: AuthProfile | undefined) => void) => () => void;
      onAuthRequired: (listener: () => void) => () => void;
      openReleasePage: () => Promise<void>;
      installUpdate: () => Promise<void>;
      onUpdateState: (listener: (notice: UpdateNotice) => void) => () => void;
      getBehavior: () => Promise<BehaviorSettings>;
      saveBehavior: (behavior: BehaviorSettings) => Promise<BehaviorSettings>;
      getHandsFree: () => Promise<HandsFreeStatus>;
      onHandsFree: (listener: (status: HandsFreeStatus) => void) => () => void;
      respondConfirm: (approved: boolean) => void;
      send: (event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => void;
      subscribe: (listener: (snapshot: OverlaySnapshot) => void) => () => void;
    };
  }
}

export {};
