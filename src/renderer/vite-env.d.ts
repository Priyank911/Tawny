import type { OverlaySnapshot, ProviderSettings } from '../shared/contracts';

declare module '*.css';

declare global {
  interface Window {
    voiceRouter: {
      getSnapshot: () => Promise<OverlaySnapshot>;
      getSettings: () => Promise<ProviderSettings>;
      saveSettings: (settings: ProviderSettings) => Promise<void>;
      onOpenSettings: (listener: () => void) => () => void;
      enterBackground: () => Promise<void>;
      onBackgroundMode: (listener: () => void) => () => void;
      send: (event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => void;
      subscribe: (listener: (snapshot: OverlaySnapshot) => void) => () => void;
    };
  }
}

export {};
