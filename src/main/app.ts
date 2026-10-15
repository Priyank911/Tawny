import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, Tray } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createActor } from 'xstate';
import { pipelineMachine } from './pipeline/machine';
import { gateTranscript } from './pipeline/gate';
import { isImageGenerationRequest } from './pipeline/intent';
import { pasteImage, pasteText } from './inject';
import type { OverlaySnapshot } from '../shared/contracts';
import { readProviderSettings, saveProviderSettings } from './settings';
import { generateWithCloudflareFlux } from './providers/cloudflareFlux';
import { transcribeWithGroq } from './providers/groqWhisper';
import { getRecentLogs, logPipeline, setLogSink } from './logger';
import { startKeyWatcher, watchKeyRelease, cancelKeyReleaseWatch, makeWindowTopmost, stopKeyWatcher } from './keywatcherService';

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let snapshot: OverlaySnapshot = { state: 'idle', elapsedMs: 0, rms: 0 };
let readyTimer: NodeJS.Timeout | undefined;
let quitting = false;
let escapeRegistered = false;
let backgroundMode = false;
let activeJobId: string | undefined;
let finalizingTimer: NodeJS.Timeout | undefined;
let routingTimer: NodeJS.Timeout | undefined;
let stopPending = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    showOverlay();
    mainWindow.focus();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    show: true,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    icon: join(__dirname, '../renderer/tawny-mark.svg'),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setAlwaysOnTop(false);
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.once('ready-to-show', () => {
    console.log('Tawny main page is ready. Choose Run in background to minimize to the tray.');
  });
  mainWindow.on('blur', () => {
    if (backgroundMode && snapshot.state === 'idle') mainWindow?.hide();
  });
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

function showOverlay(): void {
  if (!mainWindow) return;
  backgroundMode = true;
  mainWindow.webContents.send('app:background-mode');
  mainWindow.setSkipTaskbar(true);
  mainWindow.setResizable(false);
  mainWindow.setSize(620, 72);
  mainWindow.setFocusable(false);

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.workArea;
  const targetX = Math.round(bounds.x + (bounds.width - 620) / 2);
  const targetY = Math.round(bounds.y + 16);

  if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
    mainWindow.setPosition(targetX, targetY);
  } else {
    mainWindow.center();
  }

  // Ensure window is always on top and in front of all open applications
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.showInactive();
  mainWindow.moveTop();

  try {
    const handle = mainWindow.getNativeWindowHandle();
    const hwnd = process.arch === 'x64' ? handle.readBigInt64LE(0) : handle.readInt32LE(0);
    makeWindowTopmost(hwnd);
  } catch (err) {
    console.warn('Native topmost assertion notice:', err);
  }
}

function enterBackground(): void {
  backgroundMode = true;
  if (!mainWindow) return;
  mainWindow.setSkipTaskbar(true);
  mainWindow.setResizable(false);
  mainWindow.setSize(620, 72);
  mainWindow.setFocusable(false);
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.hide();
}

function openSettings(): void {
  if (!mainWindow) return;
  mainWindow.setSize(560, 520);
  mainWindow.setFocusable(true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.center();
  mainWindow.show();
  mainWindow.webContents.send('settings:open');
}

function openLogs(): void {
  if (!mainWindow) return;
  backgroundMode = false;
  mainWindow.setSkipTaskbar(false);
  mainWindow.setResizable(false);
  mainWindow.setSize(760, 560);
  mainWindow.setFocusable(true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.center();
  mainWindow.show();
  mainWindow.webContents.send('logs:open');
}

function stopRecording(): void {
  if (snapshot.state !== 'recording') {
    if (snapshot.state === 'arming') {
      stopPending = true;
    }
    return;
  }
  stopPending = false;
  cancelKeyReleaseWatch();
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = undefined;
  }
  logPipeline({ event: 'capture.stop', message: 'Stopping capture and finalizing audio automatically.', jobId: activeJobId, stage: 'capture' });
  actor.send({ type: 'STOP' });
  if (finalizingTimer) clearTimeout(finalizingTimer);
  finalizingTimer = setTimeout(() => {
    finalizingTimer = undefined;
    if (snapshot.state !== 'finalizing') return;
    const message = 'Audio finalization timed out before Groq transcription started.';
    logPipeline({ level: 'error', event: 'capture.timeout', message, jobId: activeJobId, stage: 'capture', errorClass: 'environment' });
    actor.send({ type: 'FAIL', message });
  }, 35_000);
}

function setEscapeShortcut(enabled: boolean): void {
  if (enabled && !escapeRegistered) {
    escapeRegistered = globalShortcut.register('Escape', () => {
      if (snapshot.state !== 'idle') {
        logPipeline({ event: 'escape.cancel', message: 'Escape pressed; cancelling active job.', jobId: activeJobId, errorClass: 'cancelled' });
        actor.send({ type: 'CANCEL' });
      }
    });
  } else if (!enabled && escapeRegistered) {
    globalShortcut.unregister('Escape');
    escapeRegistered = false;
  }
}

function createTray(): void {
  const traySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 64 64"><rect width="64" height="64" rx="20" fill="#26302b"/><path d="M19 21h26M32 21v23" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><path d="M16 38c3.5-4 7-4 10.5 0s7 4 10.5 0 7-4 10.5 0" fill="none" stroke="#91a77f" stroke-width="4" stroke-linecap="round"/></svg>';
  tray = new Tray(nativeImage.createFromBuffer(Buffer.from(traySvg)));
  tray.setToolTip('Tawny');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show Tawny',
      click: showOverlay
    },
    {
      label: 'Hide overlay',
      click: () => mainWindow?.hide()
    },
    {
      label: 'Settings',
      click: openSettings
    },
    {
      label: 'Diagnostics',
      click: openLogs
    },
    { type: 'separator' },
    {
      label: 'Quit Tawny',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('click', showOverlay);
}

const actor = createActor(pipelineMachine);
setLogSink((entry) => mainWindow?.webContents.send('pipeline:log', entry));
actor.subscribe((state) => {
  const nextState = state.value as OverlaySnapshot['state'];
  if (nextState === 'transcribing' && finalizingTimer) {
    clearTimeout(finalizingTimer);
    finalizingTimer = undefined;
  }
  if (nextState !== 'deciding' && routingTimer) {
    clearTimeout(routingTimer);
    routingTimer = undefined;
  }
  snapshot = {
    ...snapshot,
    state: nextState,
    ...(typeof state.context.message === 'string' ? { message: state.context.message } : {})
  };
  logPipeline({
    event: 'state.transition',
    message: `Pipeline state: ${nextState}`,
    jobId: activeJobId,
    data: { state: nextState }
  });
  setEscapeShortcut(state.value !== 'idle');
  mainWindow?.webContents.send('overlay:update', snapshot);
  if (state.value === 'idle' && mainWindow?.isVisible()) {
    const windowRef = mainWindow;
    setTimeout(() => {
      if (windowRef.getSize()[1] !== 72) windowRef.setSize(620, 72);
      windowRef.hide();
    }, 450);
  }
});
actor.start();

function showContextMenu(): void {
  const menu = Menu.buildFromTemplate([
    { label: 'Open diagnostics', click: openLogs },
    { label: 'Settings', click: openSettings },
    { type: 'separator' },
    {
      label: snapshot.state === 'recording' ? 'Finish capture' : 'Cancel current job',
      enabled: snapshot.state !== 'idle' && snapshot.state !== 'done',
      click: () => snapshot.state === 'recording' ? stopRecording() : actor.send({ type: 'CANCEL' })
    }
  ]);
  menu.popup({ window: mainWindow });
}

function handlePipelineEvent(event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM'): void {
  if (event === 'STOP') {
    stopRecording();
    return;
  }
  actor.send({ type: event });
}

ipcMain.handle('overlay:get-snapshot', () => snapshot);
ipcMain.handle('logs:get', () => getRecentLogs());
ipcMain.on('capture:log', (_event, input: { event: string; message: string; level?: 'debug' | 'info' | 'warn' | 'error'; data?: Record<string, string> }) => {
  logPipeline({ ...input, jobId: activeJobId, stage: 'capture' });
  if (input.event === 'capture.failure') actor.send({ type: 'FAIL', message: input.message });
});
ipcMain.handle('app:enter-background', () => enterBackground());
ipcMain.handle('settings:get', () => readProviderSettings());
ipcMain.handle('settings:save', async (_event, settings) => {
  await saveProviderSettings(settings);
  logPipeline({ event: 'settings.saved', message: 'Provider settings saved securely.' });
});
ipcMain.handle('image:generate', async (_event, prompt: unknown) => {
  const startedAt = Date.now();
  const settings = await readProviderSettings();
  if (typeof prompt !== 'string') {
    logPipeline({ level: 'error', event: 'image.invalid_input', message: 'Image prompt was not text.', jobId: activeJobId, stage: 'handle', errorClass: 'input' });
    throw new Error('Image prompt must be text.');
  }
  logPipeline({ event: 'provider.start', message: 'Starting Cloudflare Flux image generation.', jobId: activeJobId, stage: 'handle', provider: 'cloudflare-flux' });
  try {
    const result = await generateWithCloudflareFlux(settings.cloudflareAccountId, settings.cloudflareApiToken, { prompt });
    logPipeline({ event: 'provider.success', message: 'Cloudflare Flux returned an image.', jobId: activeJobId, stage: 'handle', provider: 'cloudflare-flux', durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logPipeline({ level: 'error', event: 'provider.failure', message: error instanceof Error ? error.message : 'Cloudflare Flux failed.', jobId: activeJobId, stage: 'handle', provider: 'cloudflare-flux', durationMs: Date.now() - startedAt });
    throw error;
  }
});
ipcMain.handle('audio:transcribe', async (_event, audio: Uint8Array) => {
  const startedAt = Date.now();
  const settings = await readProviderSettings();
  actor.send({ type: 'STAGE', stage: 'transcribing' });
  logPipeline({ event: 'provider.start', message: 'Uploading captured audio to Groq Whisper.', jobId: activeJobId, stage: 'stt', provider: 'groq-whisper', data: { bytes: String(audio?.byteLength ?? 0) } });
  try {
    const transcript = await transcribeWithGroq(settings.groqApiKey, audio);
    if (!transcript) throw new Error('Groq returned an empty transcript.');
    logPipeline({ event: 'provider.success', message: 'Groq Whisper returned a transcript.', jobId: activeJobId, stage: 'stt', provider: 'groq-whisper', durationMs: Date.now() - startedAt });
    snapshot = { ...snapshot, message: `Heard: ${transcript}` };
    mainWindow?.webContents.send('overlay:update', snapshot);

    actor.send({ type: 'STAGE', stage: 'gating' });
    const gate = gateTranscript(transcript);
    logPipeline({
      event: 'gate.result',
      message: gate.routed ? 'Wake phrase accepted.' : 'Wake phrase not detected.',
      jobId: activeJobId,
      stage: 'gate',
      data: { routed: String(gate.routed), commandLength: String(gate.text.length) }
    });

    actor.send({ type: 'STAGE', stage: 'deciding' });

    // Check if this is an image generation request
    const isImage = isImageGenerationRequest(gate.routed ? gate.text : transcript)
      || isImageGenerationRequest(transcript);

    if (isImage) {
      const promptText = gate.routed && gate.text ? gate.text : transcript;
      logPipeline({ event: 'decision.result', message: 'Image intent detected.', jobId: activeJobId, stage: 'decide', data: { intent: 'image_generate', prompt: promptText } });
      actor.send({ type: 'STAGE', stage: 'handling' });
      const image = await generateWithCloudflareFlux(settings.cloudflareAccountId, settings.cloudflareApiToken, { prompt: promptText });
      const outputPath = join(app.getPath('userData'), `tawny-image-${Date.now()}.jpg`);
      await writeFile(outputPath, Buffer.from(image.base64, 'base64'));
      logPipeline({ event: 'image.saved', message: 'Cloudflare Flux image saved locally.', jobId: activeJobId, stage: 'handle', provider: 'cloudflare-flux', data: { path: outputPath } });
      actor.send({ type: 'STAGE', stage: 'injecting' });
      await pasteImage(image.base64);
      logPipeline({ event: 'image.inject.success', message: 'Generated image copied to the clipboard and pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
      snapshot = { ...snapshot, imageDataUrl: `data:${image.mimeType};base64,${image.base64}`, message: 'Image ready.' };
      mainWindow?.webContents.send('overlay:update', snapshot);
      actor.send({ type: 'SUCCESS', message: 'Image ready.' });
      return transcript;
    }

    // Normal sentence / dictation input: paste text directly at cursor pointer
    logPipeline({ event: 'decision.result', message: 'Dictation intent detected; pasting text at cursor.', jobId: activeJobId, stage: 'decide', data: { intent: 'plain_text' } });
    actor.send({ type: 'STAGE', stage: 'injecting' });
    await pasteText(transcript);
    logPipeline({ event: 'inject.success', message: 'Dictation pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
    snapshot = { ...snapshot, message: transcript };
    mainWindow?.webContents.send('overlay:update', snapshot);
    actor.send({ type: 'SUCCESS', message: 'Dictation complete.' });
    return transcript;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Groq transcription failed.';
    logPipeline({ level: 'error', event: 'provider.failure', message, jobId: activeJobId, stage: 'stt', provider: 'groq-whisper', durationMs: Date.now() - startedAt, errorClass: 'permanent' });
    actor.send({ type: 'FAIL', message });
    throw error;
  }
});
ipcMain.on('pipeline:event', (_event, event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => handlePipelineEvent(event));

app.whenReady().then(() => {
  startKeyWatcher();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = permission === 'media' && webContents.getType() === 'window';
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');
  createWindow();
  mainWindow?.webContents.on('context-menu', () => showContextMenu());
  createTray();
  const shortcut = 'Ctrl+Alt+Space';
  const registered = globalShortcut.register(shortcut, () => {
    if (!mainWindow) return;
    if (snapshot.state === 'idle' || snapshot.state === 'done' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      stopPending = false;
      activeJobId = `job-${Date.now().toString(36)}`;
      snapshot = { ...snapshot, imageDataUrl: undefined, message: undefined };
      logPipeline({ event: 'hotkey.start', message: 'Global shortcut received; starting push-to-talk capture.', jobId: activeJobId, stage: 'capture' });
      showOverlay();
      actor.send({ type: 'HOTKEY' });

      // Instant release detection: when user releases the hotkey, audio finalizes and sends automatically
      watchKeyRelease(() => {
        logPipeline({ event: 'hotkey.release', message: 'Shortcut released; finalizing capture.', jobId: activeJobId, stage: 'capture' });
        stopRecording();
      });

      readyTimer = setTimeout(() => {
        logPipeline({ event: 'capture.ready', message: 'Capture window is ready for audio.', jobId: activeJobId, stage: 'capture' });
        actor.send({ type: 'AUDIO_READY' });
        if (stopPending) {
          stopRecording();
        }
      }, 160);
    } else if (snapshot.state === 'recording') {
      logPipeline({ event: 'hotkey.stop', message: 'Global shortcut toggle received; stopping capture.', jobId: activeJobId, stage: 'capture' });
      stopRecording();
    } else if (snapshot.state === 'confirming') {
      logPipeline({ event: 'hotkey.confirm', message: 'Global shortcut received; confirming action.', jobId: activeJobId, stage: 'decide' });
      actor.send({ type: 'CONFIRM' });
    } else {
      logPipeline({ event: 'hotkey.cancel', message: 'Global shortcut received; cancelling active job.', jobId: activeJobId, errorClass: 'cancelled' });
      actor.send({ type: 'CANCEL' });
    }
  });
  if (registered) console.log(`Global shortcut registered: ${shortcut}`);
  else console.error(`Could not register ${shortcut}. Another app may own this shortcut.`);
}).catch((error: unknown) => {
  console.error('Failed to create Tawny window.', error);
  app.quit();
});
app.on('will-quit', () => {
  if (readyTimer) clearTimeout(readyTimer);
  globalShortcut.unregisterAll();
  stopKeyWatcher();
  escapeRegistered = false;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
