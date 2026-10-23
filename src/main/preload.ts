import { contextBridge, ipcRenderer } from 'electron';
import type { AuthProfile, OverlaySnapshot, PipelineLog, ProviderSettings, UpdateNotice } from '../shared/contracts';

contextBridge.exposeInMainWorld('voiceRouter', {
  getSnapshot: (): Promise<OverlaySnapshot> => ipcRenderer.invoke('overlay:get-snapshot'),
  getLogs: (): Promise<PipelineLog[]> => ipcRenderer.invoke('logs:get'),
  onLog: (listener: (entry: PipelineLog) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: PipelineLog) => listener(entry);
    ipcRenderer.on('pipeline:log', handler);
    return () => ipcRenderer.removeListener('pipeline:log', handler);
  },
  getSettings: (): Promise<ProviderSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: ProviderSettings): Promise<void> => ipcRenderer.invoke('settings:save', settings),
  generateImage: (prompt: string) => ipcRenderer.invoke('image:generate', prompt),
  transcribeAudio: (audio: Uint8Array | Uint8Array[]): Promise<string> => ipcRenderer.invoke('audio:transcribe', audio),
  logCapture: (input: { event: string; message: string; level?: 'debug' | 'info' | 'warn' | 'error'; data?: Record<string, string> }): void => ipcRenderer.send('capture:log', input),
  onOpenSettings: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('settings:open', handler);
    return () => ipcRenderer.removeListener('settings:open', handler);
  },
  onOpenLogs: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('logs:open', handler);
    return () => ipcRenderer.removeListener('logs:open', handler);
  },
  enterBackground: (): Promise<void> => ipcRenderer.invoke('app:enter-background'),
  onBackgroundMode: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('app:background-mode', handler);
    return () => ipcRenderer.removeListener('app:background-mode', handler);
  },
  getAuthProfile: (): Promise<AuthProfile | undefined> => ipcRenderer.invoke('auth:get-profile'),
  signIn: (): Promise<AuthProfile> => ipcRenderer.invoke('auth:sign-in'),
  cancelSignIn: (): Promise<void> => ipcRenderer.invoke('auth:cancel'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
  onAuthProfile: (listener: (profile: AuthProfile | undefined) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, profile: AuthProfile | undefined) => listener(profile);
    ipcRenderer.on('auth:profile', handler);
    return () => ipcRenderer.removeListener('auth:profile', handler);
  },
  onAuthRequired: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('auth:required', handler);
    return () => ipcRenderer.removeListener('auth:required', handler);
  },
  openReleasePage: (): Promise<void> => ipcRenderer.invoke('updates:open-release'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updates:install'),
  onUpdateState: (listener: (notice: UpdateNotice) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, notice: UpdateNotice) => listener(notice);
    ipcRenderer.on('updates:state', handler);
    return () => ipcRenderer.removeListener('updates:state', handler);
  },
  send: (event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => ipcRenderer.send('pipeline:event', event),
  subscribe: (listener: (snapshot: OverlaySnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: OverlaySnapshot) => listener(snapshot);
    ipcRenderer.on('overlay:update', handler);
    return () => ipcRenderer.removeListener('overlay:update', handler);
  }
});
