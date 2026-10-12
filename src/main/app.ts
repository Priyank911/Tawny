import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from 'electron';
import { join } from 'node:path';
import { createActor } from 'xstate';
import { pipelineMachine } from './pipeline/machine';
import type { OverlaySnapshot } from '../shared/contracts';
import { readProviderSettings, saveProviderSettings } from './settings';

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let snapshot: OverlaySnapshot = { state: 'idle', elapsedMs: 0, rms: 0 };
let readyTimer: NodeJS.Timeout | undefined;
let quitting = false;
let escapeRegistered = false;
let backgroundMode = false;
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
  mainWindow.setSize(440, 210);
  mainWindow.setAlwaysOnTop(true, 'floating');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.workArea;
  const windowBounds = mainWindow.getBounds();
  const targetX = bounds.x + Math.round((bounds.width - windowBounds.width) / 2);
  const targetY = bounds.y + 24;
  const startY = targetY - 44;
  mainWindow.setPosition(targetX, startY);
  mainWindow.showInactive();
  console.log(`Tawny overlay shown at top-center of ${display.label}.`);
  const startedAt = Date.now();
  const duration = 240;
  const animation = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(animation);
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    mainWindow.setPosition(targetX, Math.round(startY + (targetY - startY) * eased));
    if (progress === 1) clearInterval(animation);
  }, 16);
}

function enterBackground(): void {
  backgroundMode = true;
  if (!mainWindow) return;
  mainWindow.setSkipTaskbar(true);
  mainWindow.setResizable(false);
  mainWindow.setSize(440, 210);
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.hide();
}

function openSettings(): void {
  if (!mainWindow) return;
  mainWindow.setSize(560, 520);
  mainWindow.center();
  mainWindow.show();
  mainWindow.webContents.send('settings:open');
}

function setEscapeShortcut(enabled: boolean): void {
  if (enabled && !escapeRegistered) {
    escapeRegistered = globalShortcut.register('Escape', () => {
      if (snapshot.state !== 'idle') actor.send({ type: 'CANCEL' });
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
actor.subscribe((state) => {
  snapshot = { ...snapshot, state: state.value as OverlaySnapshot['state'] };
  setEscapeShortcut(state.value !== 'idle');
  mainWindow?.webContents.send('overlay:update', snapshot);
  if (state.value === 'idle' && mainWindow?.isVisible()) {
    const windowRef = mainWindow;
    setTimeout(() => {
      if (windowRef.getSize()[1] !== 210) windowRef.setSize(440, 210);
      windowRef.hide();
    }, 450);
  }
});
actor.start();

ipcMain.handle('overlay:get-snapshot', () => snapshot);
ipcMain.handle('app:enter-background', () => enterBackground());
ipcMain.handle('settings:get', () => readProviderSettings());
ipcMain.handle('settings:save', (_event, settings) => saveProviderSettings(settings));
ipcMain.on('pipeline:event', (_event, event: 'HOTKEY' | 'STOP' | 'CANCEL' | 'CONFIRM') => actor.send({ type: event }));

app.whenReady().then(() => {
  createWindow();
  createTray();
  const shortcut = 'Ctrl+Alt+Space';
  const registered = globalShortcut.register(shortcut, () => {
    if (!mainWindow) return;
    if (snapshot.state === 'idle' || snapshot.state === 'done' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      showOverlay();
      actor.send({ type: 'HOTKEY' });
      readyTimer = setTimeout(() => actor.send({ type: 'AUDIO_READY' }), 180);
    } else if (snapshot.state === 'recording') {
      actor.send({ type: 'STOP' });
    } else if (snapshot.state === 'confirming') {
      actor.send({ type: 'CONFIRM' });
    } else {
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
  escapeRegistered = false;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
