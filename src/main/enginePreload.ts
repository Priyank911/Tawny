import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('engineBridge', {
  onCommand: (listener: (command: { type: 'start' | 'stop' | 'begin' | 'end'; reason?: 'send_it' | 'recognizer' | 'cancelled' }) => void) => {
    ipcRenderer.on('engine:command', (_event, command) => listener(command));
  },
  status: (status: { state: 'running' | 'stopped' | 'error'; message?: string }): void => ipcRenderer.send('engine:status', status),
  rms: (value: number): void => ipcRenderer.send('engine:rms', value),
  clip: (clip: { pcm: Uint8Array; reason: string; commandVoicedMs: number; durationMs: number; noiseFloor: number; peakRms: number }): void => ipcRenderer.send('engine:clip', clip)
});
