import { contextBridge, ipcRenderer } from 'electron';
import type { OverlaySnapshot, ProviderSettings } from '../shared/contracts';

contextBridge.exposeInMainWorld('voiceRouter', {
  getSnapshot: (): Promise<OverlaySnapshot> => ipcRenderer.invoke('overlay:get-snapshot'),
  getSettings: (): Promise<ProviderSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: ProviderSettings): Promise<void> => ipcRenderer.invoke('settings:save', settings),
  onOpenSettings: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('settings:open', handler);
    return () => ipcRenderer.removeListener('settings:open', handler);
  },
  enterBackground: (): Promise<void> => ipcRenderer.invoke('app:enter-background'),
  onBackgroundMode: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('app:background-mode', handler);
    return () => ipcRenderer.removeListener('app:background-mode', handler);
  },
  send: (event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => ipcRenderer.send('pipeline:event', event),
  subscribe: (listener: (snapshot: OverlaySnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: OverlaySnapshot) => listener(snapshot);
    ipcRenderer.on('overlay:update', handler);
    return () => ipcRenderer.removeListener('overlay:update', handler);
  }
});
