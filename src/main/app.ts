import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, session, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createActor } from 'xstate';
import { pipelineMachine } from './pipeline/machine';
import { gateTranscriptDetailed, splitWakePhrase, stripSendPhrase } from './pipeline/gate';
import { heuristicRoute, needsSelectionCapture, reconcileIntent } from './pipeline/router';
import { captureSelectedText, pasteImage, pasteText } from './inject';
import { PipelineError, type AuthProfile, type BehaviorSettings, type CaptureSource, type HandsFreeStatus, type HotkeyStatus, type HotkeyTestResult, type OverlaySnapshot, type UpdateNotice } from '../shared/contracts';
import { readProviderSettings, saveProviderSettings } from './settings';
import { DEFAULT_BEHAVIOR, readBehavior, writeBehavior } from './behavior';
import { ControlService } from './control/controlService';
import { assessPlan, type Plan, type PlanOrigin } from './control/actions';
import { planWithCloudflare } from './control/planner';
import { EngineHost, type EngineClip, type EngineStatus } from './engine/engineHost';
import { WakeService } from './wake/wakeService';
import type { ChildLike } from './native/lineProcess';
import { resolveNativeBinary } from './native/binaries';
import { encodeWav } from '../shared/audio/wav';
import { generateWithCloudflareFlux } from './providers/cloudflareFlux';
import { transcribeWithGroq } from './providers/groqWhisper';
import {
  decideWithCloudflareClef,
  generateResponseWithCloudflareClef,
  rewriteWithCloudflareClef,
  type ClefDecisionResult
} from './providers/cloudflareClef';
import { getRecentLogs, logPipeline, setLogSink } from './logger';
import { startKeyWatcher, watchKeyRelease, cancelKeyReleaseWatch, makeWindowTopmost, stopKeyWatcher } from './keywatcherService';
import { cancelGoogleSignIn, getAuthProfile, setAuthSessionInvalidatedHandler, signOut, startGoogleSignIn } from './auth';
import { initializeUpdateService, isDownloadedUpdateReady, onUpdateAvailable, openLatestReleasePage } from './updater';
import { linuxPasswordStorePreference } from './linuxKeyring';
import { DEFAULT_GLOBAL_SHORTCUT, buildCompositorTriggerCommand, isWaylandSession, normalizeGlobalShortcut } from './hotkeyConfig';
import { readGlobalShortcut, writeGlobalShortcut } from './hotkeyPreferences';
import { shouldDispatchShortcutTrigger } from './hotkeyDispatch';

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
let activeShortcut = DEFAULT_GLOBAL_SHORTCUT;
let shortcutRegistered = false;
let lastHotkeyTimestamp = 0;
let pendingShortcutTest: { resolve: (result: HotkeyTestResult) => void; timer: NodeJS.Timeout } | undefined;
let settingsReturnState: { background: boolean; bounds: { x: number; y: number; width: number; height: number }; visible: boolean } | undefined;
let rendererRecoveryUsed = false;
let settingsPanelOpen = false;
let shortcutCaptureMode = false;
let behavior: BehaviorSettings = DEFAULT_BEHAVIOR;
const control = new ControlService();
const engine = new EngineHost();
let wake: WakeService | undefined;
let handsFreeStatus: HandsFreeStatus = { enabled: false, state: 'off', message: 'Hands-free is off.' };
let wakeSessionActive = false;
let engineRestarts = 0;
let engineRestartTimer: NodeJS.Timeout | undefined;
let controlAbort: AbortController | undefined;
let pendingConfirm: { resolve: (approved: boolean) => void; timer: NodeJS.Timeout } | undefined;
let confirmKeyRegistered = false;
let clickThrough = false;
let lastRmsSent = 0;
const isWayland = isWaylandSession(process.platform, process.env);
const updateNotificationsShown = new Set<string>();
let pendingCliTrigger = process.argv.includes('--trigger');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--trigger')) {
      if (mainWindow) handleShortcutTrigger();
      else pendingCliTrigger = true;
      return;
    }
    if (!mainWindow) return;
    showOverlay();
    mainWindow.focus();
  });
}

function handleShortcutTrigger(): void {
  if (!mainWindow) return;
  if (!shouldDispatchShortcutTrigger({
    settingsOpen: settingsPanelOpen,
    captureMode: shortcutCaptureMode,
    testPending: Boolean(pendingShortcutTest)
  })) {
    logPipeline({ event: 'hotkey.ignored.settings', message: 'Ignored a shortcut trigger while Settings or shortcut recording is active.' });
    return;
  }
  if (pendingShortcutTest) {
    const test = pendingShortcutTest;
    pendingShortcutTest = undefined;
    clearTimeout(test.timer);
    const message = `Shortcut ${activeShortcut} triggered Tawny successfully.`;
    logPipeline({ event: 'hotkey.test.passed', message, data: { accelerator: activeShortcut, wayland: String(isWayland) } });
    test.resolve({ success: true, message });
    return;
  }
  const now = Date.now();
  if (now - lastHotkeyTimestamp < 400) return;
  lastHotkeyTimestamp = now;

  if (!authProfile) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('auth:required');
    return;
  }

  if (pendingConfirm) {
    logPipeline({ event: 'hotkey.confirm', message: 'Global shortcut received; confirming action.', jobId: activeJobId, stage: 'decide' });
    resolveConfirmation(true);
    return;
  }

  if (snapshot.state === 'idle' || snapshot.state === 'done' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
    stopPending = false;
    activeJobId = `job-${Date.now().toString(36)}`;
    snapshot = { ...snapshot, imageDataUrl: undefined, message: undefined, intent: undefined, confirmMessage: undefined, source: 'hotkey' };
    pendingSelectedTextPromise = captureSelectedText().catch(() => '');
    logPipeline({ event: 'hotkey.start', message: `Shortcut ${activeShortcut} received; starting audio capture.`, jobId: activeJobId, stage: 'capture' });
    actor.send({ type: 'HOTKEY' });
    showOverlay();

    const captureStartTime = Date.now();
    if (process.platform === 'win32') watchKeyRelease(() => {
      if (Date.now() - captureStartTime >= 600) {
        logPipeline({ event: 'hotkey.release', message: 'Shortcut released; finalizing capture.', jobId: activeJobId, stage: 'capture' });
        stopRecording();
      }
    });

    readyTimer = setTimeout(() => {
      logPipeline({ event: 'capture.ready', message: 'Capture window is ready for audio.', jobId: activeJobId, stage: 'capture' });
      actor.send({ type: 'AUDIO_READY' });
      if (stopPending) stopRecording();
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
}

function getCompositorCommand(): string | undefined {
  if (!isWayland) return undefined;
  const executable = process.env.APPIMAGE || process.execPath;
  return buildCompositorTriggerCommand(executable, app.isPackaged ? undefined : app.getAppPath());
}

function createHotkeyStatus(accelerator = activeShortcut): HotkeyStatus {
  return {
    accelerator,
    registered: shortcutRegistered && globalShortcut.isRegistered(accelerator),
    wayland: isWayland,
    compositorCommand: getCompositorCommand(),
    message: shortcutRegistered && globalShortcut.isRegistered(accelerator)
      ? isWayland ? 'Electron reports the portal binding active. Use the compositor command below if the key still does not trigger.' : 'Shortcut registration is confirmed by Electron.'
      : isWayland ? 'The desktop portal did not confirm this shortcut. Bind the command below in your compositor settings.' : 'Shortcut could not be registered. Choose another combination or check for a shortcut conflict.'
  };
}

async function installUpdateFromNotice(): Promise<void> {
  if (process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE)) {
    await openLatestReleasePage();
    return;
  }
  const updater = await initializeUpdateService();
  if (!updater || !isDownloadedUpdateReady()) throw new Error('The update is not fully downloaded yet. Wait for the download to finish, then try again.');
  quitting = true;
  try {
    updater.quitAndInstall(false, true);
  } catch (error) {
    quitting = false;
    throw error;
  }
}

function registerGlobalShortcut(accelerator: string): HotkeyStatus {
  if (shortcutRegistered) globalShortcut.unregister(activeShortcut);
  activeShortcut = accelerator;
  shortcutRegistered = false;
  try {
    const accepted = globalShortcut.register(accelerator, handleShortcutTrigger);
    shortcutRegistered = accepted && globalShortcut.isRegistered(accelerator);
  } catch (error) {
    logPipeline({ level: 'warn', event: 'hotkey.register.failure', message: error instanceof Error ? error.message : `Could not register ${accelerator}.` });
  }
  const status = createHotkeyStatus(accelerator);
  if (status.registered) {
    logPipeline({ event: 'hotkey.registered', message: `Electron confirmed shortcut registration for ${accelerator}.`, data: { accelerator, platform: process.platform } });
  } else {
    logPipeline({ level: 'warn', event: 'hotkey.register.failure', message: status.message, errorClass: 'environment', data: { accelerator, platform: process.platform, wayland: String(isWayland) } });
  }
  return status;
}

function notifyClipboardOnly(kind: 'text' | 'image'): string {
  const message = kind === 'text'
    ? 'Text is on your clipboard. Press Ctrl+V to paste it.'
    : 'Image is on your clipboard. Press Ctrl+V to paste it.';
  logPipeline({ level: 'warn', event: 'inject.clipboard_fallback', message, jobId: activeJobId, stage: 'inject', data: { reason: 'Wayland did not allow wtype injection' } });
  if (Notification.isSupported()) new Notification({ title: 'Tawny copied the result', body: message }).show();
  return message;
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
  mainWindow.on('unresponsive', () => {
    logPipeline({ level: 'warn', event: 'renderer.unresponsive', message: 'The Tawny window stopped responding; waiting for Electron to recover it.' });
  });
  mainWindow.on('responsive', () => {
    logPipeline({ event: 'renderer.responsive', message: 'The Tawny window is responding again.' });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logPipeline({
      level: 'error',
      event: 'renderer.process.gone',
      message: `The Tawny renderer exited (${details.reason}, code ${details.exitCode}).`,
      data: { reason: details.reason, exitCode: String(details.exitCode) }
    });
    settingsPanelOpen = false;
    shortcutCaptureMode = false;
    globalShortcut.setSuspended(false);
    if (rendererRecoveryUsed || quitting) return;
    rendererRecoveryUsed = true;
    const windowRef = mainWindow;
    setTimeout(() => {
      if (!windowRef || windowRef.isDestroyed() || windowRef.webContents.isDestroyed() || quitting) return;
      logPipeline({ level: 'warn', event: 'renderer.recovery', message: 'Reloading Tawny once after a renderer crash.' });
      windowRef.webContents.reload();
    }, 800);
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
  // Show maps the window; showInactive is unsupported on Wayland. Keep it
  // non-focusable so the previously focused editor remains the paste target.
  mainWindow.show();
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
  if (settingsPanelOpen) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  shortcutCaptureMode = false;
  globalShortcut.setSuspended(false);
  settingsPanelOpen = true;
  settingsReturnState = {
    background: backgroundMode,
    bounds: mainWindow.getBounds(),
    visible: mainWindow.isVisible()
  };
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const width = Math.min(760, display.workAreaSize.width);
  const height = Math.min(680, display.workAreaSize.height);
  backgroundMode = false;
  mainWindow.setSkipTaskbar(false);
  mainWindow.setResizable(true);
  mainWindow.setSize(width, height);
  mainWindow.setFocusable(true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.center();
  mainWindow.show();
  mainWindow.webContents.send('settings:open');
}

function closeSettingsWindow(): void {
  const previous = settingsReturnState;
  settingsReturnState = undefined;
  settingsPanelOpen = false;
  shortcutCaptureMode = false;
  globalShortcut.setSuspended(false);
  if (pendingShortcutTest) {
    const test = pendingShortcutTest;
    pendingShortcutTest = undefined;
    clearTimeout(test.timer);
    test.resolve({ success: false, message: 'Shortcut test ended because Settings was closed.' });
  }
  if (!mainWindow || !previous) return;
  if (previous.background) {
    enterBackground();
    return;
  }
  mainWindow.setBounds(previous.bounds);
  mainWindow.setSkipTaskbar(false);
  mainWindow.setFocusable(true);
  mainWindow.setAlwaysOnTop(false);
  if (previous.visible) mainWindow.show();
  else mainWindow.hide();
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
  if (snapshot.source === 'wake' && wakeSessionActive) {
    // Hands-free capture ends in the audio engine; the clip arrives through handleWakeClip.
    logPipeline({ event: 'capture.stop', message: 'Finishing the hands-free capture on request.', jobId: activeJobId, stage: 'capture' });
    engine.endSession('send_it');
    return;
  }
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
  if (nextState === 'cancelled' || nextState === 'failed' || nextState === 'idle' || nextState === 'done') {
    resolveConfirmation(false);
    if (nextState !== 'done') controlAbort?.abort();
  }
  if ((nextState === 'cancelled' || nextState === 'failed' || nextState === 'idle') && wakeSessionActive) {
    // The person cancelled (or the job failed) while the engine was still capturing: stop it quietly.
    engine.endSession('cancelled');
  }
  applyClickThrough();
  mainWindow?.webContents.send('overlay:update', snapshot);
  if (state.value === 'idle' && backgroundMode && mainWindow?.isVisible()) {
    const windowRef = mainWindow;
    setTimeout(() => {
      if (!backgroundMode || snapshot.state !== 'idle' || !windowRef.isVisible()) return;
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
    syncHandsFree();
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
  syncHandsFree();
  logPipeline({ event: 'auth.sign-out', message: 'The local Firebase session was removed from this device.' });
  mainWindow?.webContents.send('auth:profile', undefined);
});
ipcMain.handle('updates:open-release', async () => openLatestReleasePage());
ipcMain.handle('updates:install', () => installUpdateFromNotice());
ipcMain.handle('hotkey:get', () => createHotkeyStatus());
ipcMain.handle('hotkey:capture-mode', (_event, enabled: unknown) => {
  if (typeof enabled !== 'boolean') throw new Error('Shortcut capture mode must be a boolean.');
  shortcutCaptureMode = enabled;
  globalShortcut.setSuspended(enabled);
});
ipcMain.handle('hotkey:save', async (_event, value: unknown) => {
  if (pendingShortcutTest) {
    const test = pendingShortcutTest;
    pendingShortcutTest = undefined;
    clearTimeout(test.timer);
    test.resolve({ success: false, message: 'Test ended because the shortcut changed.' });
  }
  globalShortcut.setSuspended(false);
  if (typeof value !== 'string') throw new Error('Shortcut must be a key combination.');
  const accelerator = normalizeGlobalShortcut(value);
  if (!accelerator) throw new Error('Use at least one modifier (Ctrl, Alt, Shift, or Super) and one key.');
  await writeGlobalShortcut(accelerator);
  return registerGlobalShortcut(accelerator);
});
ipcMain.handle('hotkey:test', (): Promise<HotkeyTestResult> => {
  if (pendingShortcutTest) return Promise.resolve({ success: false, message: 'A shortcut test is already running.' });
  const status = createHotkeyStatus();
  if (!status.registered && !isWayland) {
    return Promise.resolve({ success: false, message: 'Tawny has not registered this shortcut. Choose another combination or resolve the shortcut conflict first.' });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingShortcutTest) return;
      pendingShortcutTest = undefined;
      const message = isWayland && !status.registered
        ? `No trigger received. Bind the copied Wayland command to ${status.accelerator} in your compositor, then test again.`
        : `No trigger received for ${status.accelerator}. Check for a system shortcut conflict and test again.`;
      logPipeline({ level: 'warn', event: 'hotkey.test.failed', message, data: { accelerator: status.accelerator, wayland: String(isWayland) } });
      resolve({ success: false, message });
    }, 10_000);
    pendingShortcutTest = { resolve, timer };
    logPipeline({ event: 'hotkey.test.started', message: `Waiting up to 10 seconds for ${status.accelerator}.`, data: { accelerator: status.accelerator } });
  });
});
ipcMain.handle('hotkey:copy-command', async () => {
  const command = getCompositorCommand();
  if (!command) throw new Error('Compositor command is available only in a Linux Wayland session.');
  await clipboard.writeText(command);
});
ipcMain.handle('settings:get', () => {
  if (!authProfile) throw new Error('Sign in with Google before opening provider settings.');
  return readProviderSettings();
});
ipcMain.handle('settings:close', () => closeSettingsWindow());
ipcMain.on('settings:state', (_event, open: unknown) => {
  if (typeof open === 'boolean') settingsPanelOpen = open;
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

// ---------------------------------------------------------------------------
// Confirmation: one mechanism for "are you sure" before a risky step. It is
// answered by Enter, the global shortcut, or the overlay buttons, and refused
// by Escape or a 12 second timeout. Nothing risky runs without an answer.
// ---------------------------------------------------------------------------

function setConfirmKey(enabled: boolean): void {
  if (enabled && !confirmKeyRegistered) {
    confirmKeyRegistered = globalShortcut.register('Enter', () => resolveConfirmation(true));
  } else if (!enabled && confirmKeyRegistered) {
    globalShortcut.unregister('Enter');
    confirmKeyRegistered = false;
  }
}

function askConfirmation(message: string): Promise<boolean> {
  resolveConfirmation(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolveConfirmation(false), 12_000);
    pendingConfirm = { resolve, timer };
    snapshot = { ...snapshot, confirmMessage: message };
    applyClickThrough();
    mainWindow?.webContents.send('overlay:update', snapshot);
    setConfirmKey(true);
    logPipeline({ event: 'control.confirm', message: `Waiting for confirmation: ${message}`, jobId: activeJobId, stage: 'decide' });
  });
}

function resolveConfirmation(approved: boolean): void {
  const pending = pendingConfirm;
  if (!pending) return;
  pendingConfirm = undefined;
  clearTimeout(pending.timer);
  setConfirmKey(false);
  snapshot = { ...snapshot, confirmMessage: undefined };
  mainWindow?.webContents.send('overlay:update', snapshot);
  pending.resolve(approved);
  if (snapshot.state === 'confirming') actor.send({ type: approved ? 'CONFIRM' : 'CANCEL' });
}

/** While Tawny drives the mouse, the overlay must not catch the clicks it is sending to the app underneath. */
function applyClickThrough(): void {
  const wakeOrb = snapshot.source === 'wake' && (snapshot.state === 'arming' || snapshot.state === 'recording');
  const driving = snapshot.intent === 'computer_control' && snapshot.state === 'handling' && !snapshot.confirmMessage;
  const wanted = wakeOrb || driving;
  if (wanted === clickThrough) return;
  clickThrough = wanted;
  mainWindow?.setIgnoreMouseEvents(wanted, { forward: false });
}

ipcMain.on('confirm:respond', (_event, approved: unknown) => {
  if (typeof approved === 'boolean') resolveConfirmation(approved);
});

// ---------------------------------------------------------------------------
// Computer control (Path E)
// ---------------------------------------------------------------------------

async function runComputerControl(input: { plan?: Plan; spoken: string; accountId: string; apiToken: string }): Promise<void> {
  const unavailable = control.unavailableReason();
  if (unavailable) throw new PipelineError('environment', 'handle', unavailable);
  const abort = new AbortController();
  controlAbort = abort;
  try {
    let plan = input.plan;
    let origin: PlanOrigin = 'grammar';
    if (!plan) {
      origin = 'planner';
      snapshot = { ...snapshot, message: 'Working out the steps…' };
      mainWindow?.webContents.send('overlay:update', snapshot);
      const context = await control.plannerContext().catch(() => ({ windows: [], drives: [] }));
      const planned = await planWithCloudflare(input.accountId, input.apiToken, input.spoken, context, abort.signal);
      if (!planned.ok) throw new PipelineError('input', 'decide', planned.reason);
      plan = planned.plan;
    }
    logPipeline({ event: 'control.plan', message: `Plan from ${origin}: ${plan.steps.map((step) => step.verb).join(' > ')}`, jobId: activeJobId, stage: 'decide', data: { origin, steps: String(plan.steps.length) } });

    const assessment = assessPlan(plan, origin);
    if (assessment.blocked) throw new PipelineError('permanent', 'decide', assessment.blocked);
    if (assessment.confirm) {
      actor.send({ type: 'STAGE', stage: 'confirming' });
      const approved = await askConfirmation(assessment.confirm);
      if (!approved) return; // Escape or timeout already moved the pipeline to cancelled.
    } else {
      actor.send({ type: 'STAGE', stage: 'handling' });
    }

    const result = await control.run({
      plan,
      signal: abort.signal,
      style: behavior.controlStyle,
      ...(behavior.visionFallback && input.accountId && input.apiToken ? { vision: { accountId: input.accountId, apiToken: input.apiToken } } : {}),
      confirm: askConfirmation,
      progress: (message) => {
        snapshot = { ...snapshot, message };
        mainWindow?.webContents.send('overlay:update', snapshot);
      },
      note: (event, message) => logPipeline({ event: `control.${event}`, message, jobId: activeJobId, stage: 'handle' })
    });
    logPipeline({ level: result.ok ? 'info' : 'warn', event: result.ok ? 'control.done' : 'control.failed', message: result.message, jobId: activeJobId, stage: 'handle' });
    snapshot = { ...snapshot, message: result.message };
    if (result.ok) actor.send({ type: 'SUCCESS', message: result.message });
    else actor.send({ type: 'FAIL', message: result.message });
  } finally {
    if (controlAbort === abort) controlAbort = undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared audio pipeline. The hotkey path (browser recording, webm) and the
// hands-free path (engine clip, wav) both end here.
// ---------------------------------------------------------------------------

interface ProcessOptions {
  source: CaptureSource;
  mimeType: string;
}

function discardJob(reason: string): void {
  logPipeline({ event: 'job.discarded', message: reason, jobId: activeJobId, stage: 'gate' });
  snapshot = { ...snapshot, message: undefined, intent: undefined, confirmMessage: undefined };
  actor.send({ type: 'DISCARD' });
}

async function processAudio(segments: Uint8Array[], options: ProcessOptions): Promise<string> {
  if (!authProfile) throw new Error('Sign in with Google before using Tawny.');
  const startedAt = Date.now();
  const settings = await readProviderSettings();
  const totalBytes = segments.reduce((total, segment) => total + (segment?.byteLength ?? 0), 0);
  const wakeSource = options.source === 'wake';
  actor.send({ type: 'STAGE', stage: 'transcribing' });
  logPipeline({
    event: 'provider.start',
    message: `Uploading ${segments.length} audio segment${segments.length === 1 ? '' : 's'} to Groq Whisper.`,
    jobId: activeJobId,
    stage: 'stt',
    provider: 'groq-whisper',
    data: { bytes: String(totalBytes), segments: String(segments.length), source: options.source }
  });
  try {
    const transcript = await transcribeWithGroq(settings.groqApiKey, segments, options.mimeType);
    if (!transcript) {
      if (wakeSource) {
        discardJob('The hands-free clip had no recognizable speech.');
        return '';
      }
      throw new Error('Groq returned an empty transcript.');
    }
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
    // Hands-free clips must open with a real wake phrase: the local recognizer only suggests a wake, this check confirms it.
    const spoken = wakeSource ? stripSendPhrase(transcript).text : transcript;
    const gate = wakeSource
      ? (() => {
        const split = splitWakePhrase(spoken);
        return { routed: split.routed, text: split.command, original: split.original };
      })()
      : gateTranscriptDetailed(transcript);
    logPipeline({
      event: 'gate.result',
      message: gate.routed ? 'Wake phrase accepted.' : 'Wake phrase not detected.',
      jobId: activeJobId,
      stage: 'gate',
      data: { routed: String(gate.routed), commandLength: String(gate.text.length), source: options.source }
    });
    if (wakeSource && (!gate.routed || !gate.text)) {
      discardJob(gate.routed ? 'Hey Tawny was said with no command after it.' : 'The speech did not start with a wake phrase; nothing was done.');
      return '';
    }

    actor.send({ type: 'STAGE', stage: 'deciding' });

    // Selected text: the hotkey path captured it when the key was pressed. A hands-free command captures it only when it could be an edit.
    let selectedText = '';
    try {
      selectedText = wakeSource
        ? (needsSelectionCapture(gate.original, gate.text) ? await captureSelectedText() : '')
        : (await pendingSelectedTextPromise) || '';
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

    // Deterministic guardrails first; CLEF picks the tier for them, or classifies speech that was addressed to Tawny.
    const route = heuristicRoute({
      transcript,
      source: options.source,
      gateRouted: gate.routed,
      gateCommand: gate.text,
      gateOriginal: gate.original,
      selectedText
    });
    let decision: ClefDecisionResult | undefined;
    if (route.fastRewrite) decision = { intent: 'text_rewrite', tier: 'fast', confidence: 1 };
    else if (route.consult !== 'none') {
      decision = await decideWithCloudflareClef(settings.cloudflareAccountId, settings.cloudflareApiToken, { command: route.command, selectedText }, route.intent);
    }
    const tier = decision?.tier ?? 'low';
    const resolved = reconcileIntent(route, decision, selectedText);
    const intent = resolved.intent;
    const routedCommand = route.command;

    logPipeline({
      event: 'decision.result',
      message: route.consult === 'none' && !route.matched
        ? 'Plain dictation detected; no model response requested.'
        : `Intent: ${intent} (${resolved.reason})`,
      jobId: activeJobId,
      stage: 'decide',
      data: {
        intent,
        reason: resolved.reason,
        guardrail: String(route.matched),
        tier,
        ...(decision ? { confidence: String(decision.confidence), clefIntent: decision.intent } : {})
      }
    });

    snapshot = { ...snapshot, intent };
    mainWindow?.webContents.send('overlay:update', snapshot);

    // Path A: Image generation
    if (intent === 'image_generate') {
      const promptText = routedCommand || transcript;
      actor.send({ type: 'STAGE', stage: 'handling' });
      const image = await generateWithCloudflareFlux(settings.cloudflareAccountId, settings.cloudflareApiToken, { prompt: promptText });
      const outputPath = join(app.getPath('userData'), `tawny-image-${Date.now()}.jpg`);
      await writeFile(outputPath, Buffer.from(image.base64, 'base64'));
      logPipeline({ event: 'image.saved', message: 'Cloudflare Flux image saved locally.', jobId: activeJobId, stage: 'handle', provider: 'cloudflare-flux', data: { path: outputPath } });
      actor.send({ type: 'STAGE', stage: 'injecting' });
      const pasteResult = await pasteImage(image.base64);
      const completionMessage = pasteResult === 'clipboard' ? notifyClipboardOnly('image') : 'Image ready.';
      logPipeline({ event: 'image.inject.success', message: pasteResult === 'clipboard' ? 'Generated image is on the clipboard; Wayland did not permit automatic paste.' : 'Generated image copied to the clipboard and pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
      snapshot = { ...snapshot, imageDataUrl: `data:${image.mimeType};base64,${image.base64.trim()}`, message: completionMessage };
      mainWindow?.webContents.send('overlay:update', snapshot);
      actor.send({ type: 'SUCCESS', message: completionMessage });
      return transcript;
    }

    // Path B: Text rewrite on selected text
    if (intent === 'text_rewrite' && selectedText) {
      const commandText = routedCommand || transcript;
      actor.send({ type: 'STAGE', stage: 'handling' });
      const rewrite = await rewriteWithCloudflareClef(
        settings.cloudflareAccountId,
        settings.cloudflareApiToken,
        { selectedText, command: commandText, tier }
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
      const pasteResult = await pasteText(rewrite.text);
      const completionMessage = pasteResult === 'clipboard' ? notifyClipboardOnly('text') : 'Rewrite complete.';
      logPipeline({ event: 'inject.success', message: pasteResult === 'clipboard' ? 'Rewritten text is on the clipboard; Wayland did not permit automatic paste.' : 'Rewritten text pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
      snapshot = { ...snapshot, message: completionMessage };
      mainWindow?.webContents.send('overlay:update', snapshot);
      actor.send({ type: 'SUCCESS', message: completionMessage });
      return rewrite.text;
    }

    // Path C: Text query / code generation (e.g. "give me python code for making calculator")
    if (intent === 'text_query') {
      const commandText = routedCommand || transcript;
      actor.send({ type: 'STAGE', stage: 'handling' });
      const responseText = await generateResponseWithCloudflareClef(
        settings.cloudflareAccountId,
        settings.cloudflareApiToken,
        { command: commandText, context: selectedText, tier }
      );
      logPipeline({
        event: 'provider.success',
        message: 'Cloudflare CLEF assistant response completed.',
        jobId: activeJobId,
        stage: 'handle',
        provider: 'cloudflare-clef',
        data: { tier }
      });
      actor.send({ type: 'STAGE', stage: 'injecting' });
      const pasteResult = await pasteText(responseText);
      const completionMessage = pasteResult === 'clipboard' ? notifyClipboardOnly('text') : 'Response ready.';
      logPipeline({ event: 'inject.success', message: pasteResult === 'clipboard' ? 'Assistant response is on the clipboard; Wayland did not permit automatic paste.' : 'Assistant response pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
      snapshot = { ...snapshot, message: completionMessage };
      mainWindow?.webContents.send('overlay:update', snapshot);
      actor.send({ type: 'SUCCESS', message: completionMessage });
      return responseText;
    }

    // Path E: Computer control (open things, click, type, press keys)
    if (intent === 'computer_control') {
      await runComputerControl({
        ...(route.control ? { plan: route.control } : {}),
        spoken: gate.original || routedCommand,
        accountId: settings.cloudflareAccountId,
        apiToken: settings.cloudflareApiToken
      });
      return transcript;
    }

    // Path D: Normal sentence / dictation input: paste text directly at cursor pointer
    logPipeline({ event: 'decision.result', message: 'Dictation intent detected; pasting text at cursor.', jobId: activeJobId, stage: 'decide', data: { intent: 'plain_text' } });
    actor.send({ type: 'STAGE', stage: 'injecting' });
    const dictation = wakeSource ? gate.original : transcript;
    const pasteResult = await pasteText(dictation);
    const completionMessage = pasteResult === 'clipboard' ? notifyClipboardOnly('text') : 'Dictation complete.';
    logPipeline({ event: 'inject.success', message: pasteResult === 'clipboard' ? 'Dictation is on the clipboard; Wayland did not permit automatic paste.' : 'Dictation pasted into the previously focused application.', jobId: activeJobId, stage: 'inject' });
    snapshot = { ...snapshot, message: completionMessage };
    mainWindow?.webContents.send('overlay:update', snapshot);
    actor.send({ type: 'SUCCESS', message: completionMessage });
    return dictation;
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
}

ipcMain.handle('audio:transcribe', (_event, audio: Uint8Array | Uint8Array[]) => {
  const segments = Array.isArray(audio) ? audio : [audio];
  return processAudio(segments, { source: 'hotkey', mimeType: 'audio/webm' });
});

ipcMain.on('pipeline:event', (_event, event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => handlePipelineEvent(event));

// ---------------------------------------------------------------------------
// Hands-free mode: a local recognizer suggests "hey tawny", the audio engine
// captures the utterance, and Whisper confirms it before anything happens.
// ---------------------------------------------------------------------------

function publishHandsFree(status: HandsFreeStatus): void {
  handsFreeStatus = status;
  mainWindow?.webContents.send('handsfree:status', status);
  tray?.setToolTip(status.state === 'listening' ? 'Tawny (hands-free listening)' : 'Tawny');
}

function startWakeSession(): void {
  if (!authProfile || !behavior.handsFree || !mainWindow) return;
  const free = snapshot.state === 'idle' || snapshot.state === 'done' || snapshot.state === 'failed';
  if (!free || wakeSessionActive || pendingConfirm || settingsPanelOpen) {
    logPipeline({ event: 'wake.ignored', message: 'A wake phrase was heard while Tawny was busy; ignored.', data: { state: snapshot.state } });
    return;
  }
  if (!engine.beginSession()) {
    logPipeline({ level: 'warn', event: 'wake.engine_unavailable', message: 'A wake phrase was heard but the audio engine is not running.' });
    return;
  }
  wakeSessionActive = true;
  stopPending = false;
  activeJobId = `job-${Date.now().toString(36)}`;
  snapshot = { ...snapshot, imageDataUrl: undefined, message: undefined, intent: undefined, confirmMessage: undefined, source: 'wake', rms: 0 };
  logPipeline({ event: 'wake.start', message: 'Wake phrase heard; listening for the command.', jobId: activeJobId, stage: 'capture' });
  actor.send({ type: 'HOTKEY' });
  showOverlay();
  actor.send({ type: 'AUDIO_READY' });
}

function handleWakeClip(clip: EngineClip): void {
  if (!wakeSessionActive) return;
  wakeSessionActive = false;
  wake?.sessionEnded();
  if (snapshot.source !== 'wake' || snapshot.state !== 'recording') return; // cancelled or replaced while capturing
  if (clip.reason === 'cancelled' || clip.reason === 'no_command') {
    discardJob(clip.reason === 'no_command' ? 'Hey Tawny was heard but no command followed.' : 'The hands-free capture was cancelled.');
    return;
  }
  logPipeline({ event: 'wake.clip', message: `Hands-free capture finished (${clip.reason}).`, jobId: activeJobId, stage: 'capture', data: { durationMs: String(clip.durationMs), voicedMs: String(clip.commandVoicedMs) } });
  actor.send({ type: 'STOP' });
  void processAudio([encodeWav(clip.samples)], { source: 'wake', mimeType: 'audio/wav' }).catch(() => undefined);
}

/** The engine went away mid-capture (error, sleep, lock): drop the half-heard command instead of leaving the pipeline stuck. */
function abandonWakeSession(): void {
  if (!wakeSessionActive) return;
  wakeSessionActive = false;
  wake?.sessionEnded();
  if (snapshot.source === 'wake' && (snapshot.state === 'arming' || snapshot.state === 'recording')) discardJob('The microphone stopped while Tawny was listening.');
}

function ensureWake(): WakeService | undefined {
  if (wake) return wake;
  const binary = resolveNativeBinary('tawny-wake.exe', process.resourcesPath, app.getAppPath());
  if (!binary) return undefined;
  wake = new WakeService({
    spawner: () => spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike
  });
  wake.on('status', (status: HandsFreeStatus) => {
    if (engineFailed) return;
    publishHandsFree(status);
  });
  wake.on('wake', startWakeSession);
  wake.on('send', () => {
    if (wakeSessionActive) {
      logPipeline({ event: 'wake.send', message: 'Send phrase heard; finishing the capture.', jobId: activeJobId, stage: 'capture' });
      engine.endSession('send_it');
    }
  });
  wake.on('throttled', (signal: { reason: string }) => {
    logPipeline({ level: 'warn', event: 'wake.throttled', message: `A wake phrase was ignored (${signal.reason}).` });
  });
  return wake;
}

let engineFailed = false;

function onEngineStatus(status: EngineStatus): void {
  if (status.state === 'running') {
    engineRestarts = 0;
    engineFailed = false;
    if (wake) publishHandsFree(wake.current);
    return;
  }
  if (status.state !== 'error' || !behavior.handsFree) return;
  abandonWakeSession();
  engine.stop();
  if (engineRestarts >= 3) {
    engineFailed = true;
    publishHandsFree({ enabled: true, state: 'error', message: status.message ?? 'The microphone could not be started.' });
    return;
  }
  engineRestarts += 1;
  logPipeline({ level: 'warn', event: 'handsfree.engine.restart', message: `${status.message ?? 'The audio engine stopped'}; retrying (${engineRestarts}/3).` });
  if (engineRestartTimer) clearTimeout(engineRestartTimer);
  engineRestartTimer = setTimeout(() => {
    engineRestartTimer = undefined;
    if (behavior.handsFree && authProfile) engine.start();
  }, 2000 * engineRestarts);
}

function startHandsFree(): void {
  if (process.platform !== 'win32') {
    publishHandsFree({ enabled: true, state: 'error', message: 'Hands-free is available on Windows only.' });
    return;
  }
  const service = ensureWake();
  if (!service) {
    publishHandsFree({ enabled: true, state: 'error', message: 'Hands-free needs tawny-wake.exe, which is missing from this install. Reinstall Tawny to restore it.' });
    return;
  }
  engineFailed = false;
  engineRestarts = 0;
  service.start();
  engine.start();
  void control.prewarm();
}

function stopHandsFree(): void {
  if (engineRestartTimer) clearTimeout(engineRestartTimer);
  engineRestartTimer = undefined;
  abandonWakeSession();
  wake?.stop();
  engine.stop();
  publishHandsFree({ enabled: false, state: 'off', message: 'Hands-free is off.' });
}

/** Hands-free runs only while it is switched on and someone is signed in. */
function syncHandsFree(): void {
  if (behavior.handsFree && authProfile) startHandsFree();
  else if (handsFreeStatus.state !== 'off') stopHandsFree();
}

engine.on('clip', handleWakeClip);
engine.on('status', onEngineStatus);
engine.on('rms', (value: number) => {
  if (!wakeSessionActive || snapshot.state !== 'recording') return;
  const now = Date.now();
  if (now - lastRmsSent < 50) return;
  lastRmsSent = now;
  snapshot = { ...snapshot, rms: value };
  mainWindow?.webContents.send('overlay:update', snapshot);
});

ipcMain.handle('behavior:get', () => behavior);
ipcMain.handle('behavior:save', async (_event, value: unknown) => {
  const previous = behavior;
  behavior = await writeBehavior(app.getPath('userData'), value);
  if (behavior.handsFree !== previous.handsFree) syncHandsFree();
  logPipeline({ event: 'behavior.saved', message: 'Behavior settings saved.', data: { handsFree: String(behavior.handsFree), controlStyle: behavior.controlStyle, vision: String(behavior.visionFallback) } });
  return behavior;
});
ipcMain.handle('handsfree:get', () => handsFreeStatus);

onUpdateAvailable((notice: UpdateNotice) => {
  mainWindow?.webContents.send('updates:state', notice);
  if (notice.state === 'downloading' || notice.state === 'error') return;
  const notificationKey = `${notice.state}:${notice.version ?? 'latest'}`;
  if (updateNotificationsShown.has(notificationKey)) return;
  updateNotificationsShown.add(notificationKey);
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: notice.state === 'ready' ? 'Tawny update ready' : 'Tawny early preview update', body: notice.message });
  notification.on('click', () => {
    if (notice.state === 'ready') void installUpdateFromNotice().catch((error: unknown) => logPipeline({ level: 'warn', event: 'update.install.failure', message: error instanceof Error ? error.message : 'The update could not be installed.' }));
    else void openLatestReleasePage();
  });
  notification.show();
});

setAuthSessionInvalidatedHandler(() => {
  authProfile = undefined;
  syncHandsFree();
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
  behavior = await readBehavior(app.getPath('userData'));
  logPipeline({
    event: 'app.ready',
    message: `Tawny ${app.getVersion()} started on ${process.platform}.`,
    data: { version: app.getVersion(), platform: process.platform, authenticated: String(Boolean(authProfile)) }
  });
  if (isWayland) {
    logPipeline({ level: 'info', event: 'overlay.wayland.compositor-managed', message: 'Wayland controls window stacking and exact placement; use compositor window rules if Tawny does not appear above other windows.' });
  }
  startKeyWatcher();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = permission === 'media' && webContents.getType() === 'window';
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');
  createWindow();
  mainWindow?.webContents.on('context-menu', () => showContextMenu());
  createTray();
  activeShortcut = await readGlobalShortcut();
  registerGlobalShortcut(activeShortcut);
  powerMonitor.on('lock-screen', () => {
    abandonWakeSession();
    wake?.pause('Paused while the screen is locked.');
    engine.stop();
  });
  powerMonitor.on('unlock-screen', () => {
    if (behavior.handsFree && authProfile) {
      wake?.resume();
      engine.start();
    }
  });
  powerMonitor.on('suspend', () => { abandonWakeSession(); wake?.pause('Paused while the computer sleeps.'); engine.stop(); });
  powerMonitor.on('resume', () => {
    if (behavior.handsFree && authProfile) {
      wake?.resume();
      engine.start();
    }
  });
  syncHandsFree();
  if (pendingCliTrigger) {
    pendingCliTrigger = false;
    setTimeout(handleShortcutTrigger, 350);
  }
  void initializeUpdateService();
}).catch((error: unknown) => {
  console.error('Failed to create Tawny window.', error);
  app.quit();
});
app.on('will-quit', () => {
  if (readyTimer) clearTimeout(readyTimer);
  if (pendingShortcutTest) {
    clearTimeout(pendingShortcutTest.timer);
    pendingShortcutTest.resolve({ success: false, message: 'Tawny closed before the shortcut test completed.' });
    pendingShortcutTest = undefined;
  }
  globalShortcut.unregisterAll();
  wake?.stop();
  engine.stop();
  control.stop();
  stopKeyWatcher();
  escapeRegistered = false;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
