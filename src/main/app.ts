import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, session, Tray } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createActor } from 'xstate';
import { pipelineMachine } from './pipeline/machine';
import { gateTranscript } from './pipeline/gate';
import { isExplicitTextQueryRequest, isFastRewriteRequest, isImageGenerationRequest, isTextRewriteRequest, stripFastRewritePrefix } from './pipeline/intent';
import { captureSelectedText, pasteImage, pasteText } from './inject';
import { PipelineError, type AuthProfile, type OverlaySnapshot, type UpdateNotice } from '../shared/contracts';
import { readProviderSettings, saveProviderSettings } from './settings';
import { generateWithCloudflareFlux } from './providers/cloudflareFlux';
import { transcribeWithGroq } from './providers/groqWhisper';
import {
  decideWithCloudflareClef,
  generateResponseWithCloudflareClef,
  rewriteWithCloudflareClef,
  type ClefIntent
} from './providers/cloudflareClef';
import { getRecentLogs, logPipeline, setLogSink } from './logger';
import { startKeyWatcher, watchKeyRelease, cancelKeyReleaseWatch, makeWindowTopmost, stopKeyWatcher } from './keywatcherService';
import { cancelGoogleSignIn, getAuthProfile, setAuthSessionInvalidatedHandler, signOut, startGoogleSignIn } from './auth';
import { initializeUpdateService, onUpdateAvailable, openLatestReleasePage } from './updater';
import { linuxPasswordStorePreference } from './linuxKeyring';

const linuxPasswordStore = linuxPasswordStorePreference(
  process.platform,
  app.commandLine.hasSwitch('password-store'),
  process.env.XDG_CURRENT_DESKTOP
);
if (linuxPasswordStore) app.commandLine.appendSwitch('password-store', linuxPasswordStore);

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
let pendingSelectedTextPromise: Promise<string> | undefined;
let authProfile: AuthProfile | undefined;
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

const OVERLAY_WIDTH = 620;
const OVERLAY_HEIGHT = 72;
const OVERLAY_TOP_INSET = 12;

function positionOverlayAtTopCenter(): void {
  if (!mainWindow) return;
  const { bounds } = screen.getPrimaryDisplay();
  const width = Math.min(OVERLAY_WIDTH, bounds.width);
  const height = Math.min(OVERLAY_HEIGHT, bounds.height);
  const x = Math.round(bounds.x + (bounds.width - width) / 2);
  const y = Math.round(bounds.y + OVERLAY_TOP_INSET);
  // Set size and position together so a previous main-window center/location
  // cannot leak into overlay mode during a hotkey transition.
  mainWindow.setBounds({ x, y, width, height }, false);
}

function showOverlay(): void {
  if (!mainWindow) return;
  backgroundMode = true;
  mainWindow.webContents.send('app:background-mode');
  mainWindow.setSkipTaskbar(true);
  mainWindow.setResizable(false);
  mainWindow.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT);
  mainWindow.setFocusable(false);
  // Ensure window is always on top and in front of all open applications
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.showInactive();
  mainWindow.moveTop();
  // Windows may restore the prior hidden-window position while showing it;
  // apply the fixed anchor once more after the native window is visible.
  positionOverlayAtTopCenter();

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
  mainWindow.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT);
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
      if (windowRef.getSize()[1] !== OVERLAY_HEIGHT) windowRef.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT);
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
  if (!authProfile && event === 'HOTKEY') return;
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
ipcMain.handle('app:enter-background', () => {
  if (!authProfile) throw new Error('Sign in with Google before moving Tawny to the background.');
  enterBackground();
});
ipcMain.handle('auth:get-profile', async () => {
  authProfile = await getAuthProfile();
  return authProfile;
});
ipcMain.handle('auth:sign-in', async () => {
  try {
    authProfile = await startGoogleSignIn();
    logPipeline({ event: 'auth.sign-in.success', message: 'Google sign-in completed with Firebase.' });
    mainWindow?.webContents.send('auth:profile', authProfile);
    return authProfile;
  } catch (error) {
    logPipeline({ level: 'warn', event: 'auth.sign-in.failure', message: 'Google sign-in did not complete.' });
    throw error;
  }
});
ipcMain.handle('auth:cancel', async () => cancelGoogleSignIn());
ipcMain.handle('auth:sign-out', async () => {
  await signOut();
  authProfile = undefined;
  logPipeline({ event: 'auth.sign-out', message: 'The local Firebase session was removed from this device.' });
  mainWindow?.webContents.send('auth:profile', undefined);
});
ipcMain.handle('updates:open-release', async () => openLatestReleasePage());
ipcMain.handle('updates:install', async () => {
  if (process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE)) return openLatestReleasePage();
  const updater = await initializeUpdateService();
  if (updater) updater.quitAndInstall();
  else await openLatestReleasePage();
});
ipcMain.handle('settings:get', () => {
  if (!authProfile) throw new Error('Sign in with Google before opening provider settings.');
  return readProviderSettings();
});
ipcMain.handle('settings:save', async (_event, settings) => {
  if (!authProfile) throw new Error('Sign in with Google before saving provider settings.');
  await saveProviderSettings(settings);
  logPipeline({ event: 'settings.saved', message: 'Provider settings saved securely.' });
});
ipcMain.handle('image:generate', async (_event, prompt: unknown) => {
  if (!authProfile) throw new Error('Sign in with Google before using Tawny.');
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

ipcMain.handle('audio:transcribe', async (_event, audio: Uint8Array | Uint8Array[]) => {
  if (!authProfile) throw new Error('Sign in with Google before using Tawny.');
  const startedAt = Date.now();
  const settings = await readProviderSettings();
  const segments = Array.isArray(audio) ? audio : [audio];
  const totalBytes = segments.reduce((total, segment) => total + (segment?.byteLength ?? 0), 0);
  actor.send({ type: 'STAGE', stage: 'transcribing' });
  logPipeline({
    event: 'provider.start',
    message: `Uploading ${segments.length} audio segment${segments.length === 1 ? '' : 's'} to Groq Whisper.`,
    jobId: activeJobId,
    stage: 'stt',
    provider: 'groq-whisper',
    data: { bytes: String(totalBytes), segments: String(segments.length) }
  });
  try {
    const transcript = await transcribeWithGroq(settings.groqApiKey, segments);
    if (!transcript) throw new Error('Groq returned an empty transcript.');
    logPipeline({
      event: 'provider.success',
      message: 'Groq Whisper returned a transcript.',
      jobId: activeJobId,
      stage: 'stt',
      provider: 'groq-whisper',
      durationMs: Date.now() - startedAt,
      data: { characters: String(transcript.length), segments: String(segments.length) }
    });
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

    const initialCommand = (gate.routed && gate.text ? gate.text : transcript).trim();

    // 1. Retrieve selected text captured when hotkey was first pressed
    let selectedText = '';
    try {
      selectedText = (await pendingSelectedTextPromise) || '';
      logPipeline({
        event: 'selection.capture',
        message: selectedText ? 'Selected text captured from the focused app.' : 'No active text selection was detected.',
        jobId: activeJobId,
        stage: 'decide',
        data: { selectedLength: String(selectedText.length) }
      });
    } catch (error) {
      logPipeline({
        level: 'warn',
        event: 'selection.capture.failure',
        message: error instanceof Error ? error.message : 'Selected text capture failed; continuing with dictation.',
        jobId: activeJobId,
        stage: 'decide'
      });
    }

    const fastRewriteRequested = Boolean(selectedText) && isFastRewriteRequest(initialCommand);
    const routedCommand = fastRewriteRequested ? stripFastRewritePrefix(initialCommand) : initialCommand;

    // 2. Compute baseline heuristic fallback
    const isImageHeuristic = isImageGenerationRequest(routedCommand) || isImageGenerationRequest(transcript);
    const isRewriteHeuristic = Boolean(selectedText) && isTextRewriteRequest(routedCommand);
    const isCodeOrQueryHeuristic = !isImageHeuristic && !isRewriteHeuristic && isExplicitTextQueryRequest(routedCommand);
    let fallbackIntent: ClefIntent = 'plain_dictation';
    if (isImageHeuristic) fallbackIntent = 'image_generate';
    else if (isRewriteHeuristic) fallbackIntent = 'text_rewrite';
    else if (isCodeOrQueryHeuristic) fallbackIntent = 'text_query';

    // 3. Use Cloudflare CLEF only when the command explicitly needs a model.
    // Plain dictation must stay local after Whisper transcription so a normal
    // sentence can never turn into an assistant-generated response.
    const shouldUseClef = !fastRewriteRequested && (isImageHeuristic || isRewriteHeuristic || isCodeOrQueryHeuristic);
    const clefDecision = fastRewriteRequested
      ? { intent: 'text_rewrite' as const, tier: 'fast' as const, confidence: 1 }
      : shouldUseClef
      ? await decideWithCloudflareClef(
          settings.cloudflareAccountId,
          settings.cloudflareApiToken,
          { command: routedCommand, selectedText },
          fallbackIntent
        )
        : { intent: 'plain_dictation' as const, tier: 'low' as const, confidence: 1 };

    // CLEF is the primary decider. Deterministic lexical guardrails protect
    // explicit image requests and edits of selected text when a response is
    // ambiguous or the decider is temporarily unavailable.
    let resolvedIntent = clefDecision.intent;
    if (isImageHeuristic) resolvedIntent = 'image_generate';
    else if (isRewriteHeuristic) resolvedIntent = 'text_rewrite';
    else if (isCodeOrQueryHeuristic) resolvedIntent = 'text_query';
    else resolvedIntent = 'plain_dictation';

    logPipeline({
      event: 'decision.result',
      message: shouldUseClef
        ? `CLEF decided intent: ${resolvedIntent} (${clefDecision.tier} tier)`
        : 'Plain dictation detected; no model response requested.',
      jobId: activeJobId,
      stage: 'decide',
      data: {
        intent: resolvedIntent,
        clefIntent: clefDecision.intent,
        tier: clefDecision.tier,
        confidence: String(clefDecision.confidence),
        modelRouting: String(shouldUseClef)
      }
    });

    snapshot = { ...snapshot, intent: resolvedIntent };
    mainWindow?.webContents.send('overlay:update', snapshot);

    // Path A: Image generation
    if (resolvedIntent === 'image_generate') {
      const promptText = routedCommand || transcript;
      actor.send({ type: 'STAGE', stage: 'handling' });
      const image = await generateWithCloudflareFlux(settings.cloudflareAccountId, settings.cloudflareApiToken, { prompt: promptText });
      const outputPath = join(app.getPath('userData'), `tawny-image-${Date.now()}.jpg`);
      await writeFile(outputPath, Buffer.from(image.base64, 'base64'));
      logPipeline({ event: 'image.saved', message: 'Cloudflare Flux image saved locally.', jobId: activeJobId, stage: 'handle', provider: 'cloudflare-flux', data: { path: outputPath } });
      actor.send({ type: 'STAGE', stage: 'injecting' });
      await pasteImage(image.base64);
      logPipeline({ event: 'image.inject.success', message: 'Generated image copied to the clipboard and pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
      snapshot = { ...snapshot, imageDataUrl: `data:${image.mimeType};base64,${image.base64.trim()}`, message: 'Image ready.' };
      mainWindow?.webContents.send('overlay:update', snapshot);
      actor.send({ type: 'SUCCESS', message: 'Image ready.' });
      return transcript;
    }

    // Path B: Text rewrite on selected text
    if (resolvedIntent === 'text_rewrite' && selectedText) {
      const commandText = routedCommand || transcript;
      actor.send({ type: 'STAGE', stage: 'handling' });
      const rewrite = await rewriteWithCloudflareClef(
        settings.cloudflareAccountId,
        settings.cloudflareApiToken,
        { selectedText, command: commandText, tier: clefDecision.tier }
      );
      logPipeline({
        event: 'provider.success',
        message: 'Cloudflare CLEF rewrite completed.',
        jobId: activeJobId,
        stage: 'handle',
        provider: 'cloudflare-clef',
        data: { model: rewrite.model, tier: rewrite.tier, mode: rewrite.mode }
      });
      actor.send({ type: 'STAGE', stage: 'injecting' });
      await pasteText(rewrite.text);
      logPipeline({ event: 'inject.success', message: 'Rewritten text pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
      snapshot = { ...snapshot, message: rewrite.text };
      mainWindow?.webContents.send('overlay:update', snapshot);
      actor.send({ type: 'SUCCESS', message: 'Rewrite complete.' });
      return rewrite.text;
    }

    // Path C: Text query / code generation (e.g. "give me python code for making calculator")
    if (resolvedIntent === 'text_query') {
      const commandText = routedCommand || transcript;
      actor.send({ type: 'STAGE', stage: 'handling' });
      const responseText = await generateResponseWithCloudflareClef(
        settings.cloudflareAccountId,
        settings.cloudflareApiToken,
        { command: commandText, context: selectedText, tier: clefDecision.tier }
      );
      logPipeline({
        event: 'provider.success',
        message: 'Cloudflare CLEF assistant response completed.',
        jobId: activeJobId,
        stage: 'handle',
        provider: 'cloudflare-clef',
        data: { tier: clefDecision.tier }
      });
      actor.send({ type: 'STAGE', stage: 'injecting' });
      await pasteText(responseText);
      logPipeline({ event: 'inject.success', message: 'Assistant response pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
      snapshot = { ...snapshot, message: responseText };
      mainWindow?.webContents.send('overlay:update', snapshot);
      actor.send({ type: 'SUCCESS', message: 'Response ready.' });
      return responseText;
    }

    // Path D: Normal sentence / dictation input: paste text directly at cursor pointer
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
    const pipelineError = error instanceof PipelineError ? error : undefined;
    logPipeline({
      level: 'error',
      event: 'pipeline.failure',
      message,
      jobId: activeJobId,
      stage: pipelineError?.stage ?? 'stt',
      ...(pipelineError?.stage === 'stt' ? { provider: 'groq-whisper' } : {}),
      durationMs: Date.now() - startedAt,
      errorClass: pipelineError?.cls ?? 'permanent'
    });
    actor.send({ type: 'FAIL', message });
    throw error;
  }
});
ipcMain.on('pipeline:event', (_event, event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => handlePipelineEvent(event));

onUpdateAvailable((notice: UpdateNotice) => {
  mainWindow?.webContents.send('updates:state', notice);
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: notice.state === 'ready' ? 'Tawny update ready' : 'Tawny early preview update', body: notice.message });
  notification.on('click', () => {
    if (notice.state === 'ready' && process.platform !== 'darwin' && !(process.platform === 'linux' && !process.env.APPIMAGE)) {
      void initializeUpdateService().then((updater) => updater?.quitAndInstall());
    } else {
      void openLatestReleasePage();
    }
  });
  notification.show();
});

setAuthSessionInvalidatedHandler(() => {
  authProfile = undefined;
  logPipeline({ level: 'warn', event: 'auth.session.expired', message: 'The saved Firebase session is no longer valid; Google sign-in is required.' });
  mainWindow?.webContents.send('auth:profile', undefined);
  mainWindow?.webContents.send('auth:required');
});

app.whenReady().then(async () => {
  screen.on('display-metrics-changed', () => {
    if (backgroundMode && mainWindow?.isVisible()) positionOverlayAtTopCenter();
  });
  if (process.platform === 'win32') app.setAppUserModelId('com.tawny.desktop');
  authProfile = await getAuthProfile();
  logPipeline({
    event: 'app.ready',
    message: `Tawny ${app.getVersion()} started on ${process.platform}.`,
    data: { version: app.getVersion(), platform: process.platform, authenticated: String(Boolean(authProfile)) }
  });
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
  let lastHotkeyTimestamp = 0;
  const registered = globalShortcut.register(shortcut, () => {
    if (!mainWindow) return;
    const now = Date.now();
    // Ignore OS auto-repeat keystrokes that fire repeatedly while hotkey is held
    if (now - lastHotkeyTimestamp < 400) {
      return;
    }
    lastHotkeyTimestamp = now;

    if (!authProfile) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('auth:required');
      return;
    }

    if (snapshot.state === 'idle' || snapshot.state === 'done' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      stopPending = false;
      activeJobId = `job-${Date.now().toString(36)}`;
      snapshot = { ...snapshot, imageDataUrl: undefined, message: undefined, intent: undefined };
      // Probe active selected text immediately while focused window is active:
      pendingSelectedTextPromise = captureSelectedText().catch(() => '');
      logPipeline({ event: 'hotkey.start', message: 'Global shortcut received; starting audio capture.', jobId: activeJobId, stage: 'capture' });
      showOverlay();
      actor.send({ type: 'HOTKEY' });

      // Hold-to-talk release detection: only triggers if held for > 600ms and then released
      const captureStartTime = Date.now();
      if (process.platform === 'win32') watchKeyRelease(() => {
        // Enforce that release only finalizes if user actually held for at least 600ms
        if (Date.now() - captureStartTime >= 600) {
          logPipeline({ event: 'hotkey.release', message: 'Shortcut released; finalizing capture.', jobId: activeJobId, stage: 'capture' });
          stopRecording();
        }
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
  if (registered) {
    console.log(`Global shortcut registered: ${shortcut}`);
    logPipeline({ event: 'hotkey.registered', message: `Global shortcut ${shortcut} is ready.`, data: { accelerator: shortcut, platform: process.platform } });
  } else {
    const message = `Could not register ${shortcut}. Another app or the desktop environment may own or block this shortcut.`;
    console.error(message);
    logPipeline({ level: 'error', event: 'hotkey.register.failure', message, errorClass: 'environment', data: { accelerator: shortcut, platform: process.platform } });
  }
  void initializeUpdateService();
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
