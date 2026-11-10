import { StrictMode, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronRight, Image as ImageIcon, LoaderCircle, Sparkles, X, ShieldCheck, Code as CodeIcon, FileText as FileTextIcon, ExternalLink, Download, MousePointer2, Mic, Minus } from 'lucide-react';
import type { AuthProfile, BehaviorSettings, HandsFreeStatus, HotkeyStatus, JobHistoryEntry, OverlaySnapshot, PipelineLog, ProviderSettings, RecoveryState, UpdateNotice } from '../shared/contracts';
import { ActivityPage, HomePage, RecordingsPage, SettingsSection, Shell, type Page } from './shell';
import './styles.css';
import './shell.css';

const RECORDING_SEGMENT_MS = 60_000;
const DEFAULT_SHORTCUT = 'Ctrl+Alt+Space';

function displayShortcut(accelerator: string): string {
  return accelerator.split('+').join(' + ');
}

function acceleratorFromKeyEvent(event: ReactKeyboardEvent<HTMLButtonElement>): string | undefined {
  const key = event.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return undefined;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push(navigator.platform.toLowerCase().includes('mac') ? 'Command' : 'Super');
  const keyAliases: Record<string, string> = {
    ' ': 'Space', Escape: 'Escape', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
  };
  const normalizedKey = keyAliases[key] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase() : /^F([1-9]|1[0-9]|2[0-4])$/i.test(key) ? key.toUpperCase() : undefined);
  return normalizedKey && modifiers.length ? [...modifiers, normalizedKey].join('+') : undefined;
}

/**
 * Two windows load this page: the app window (?view=main: main page, Settings,
 * Live log) and the overlay window (?view=overlay: listening orb and status
 * pill, plus the shortcut recorder). Each renders only its own part.
 */
const VIEW: 'main' | 'overlay' = new URLSearchParams(window.location.search).get('view') === 'overlay' ? 'overlay' : 'main';
const IS_OVERLAY = VIEW === 'overlay';

function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<OverlaySnapshot>({ state: 'idle', elapsedMs: 0, rms: 0 });
  const [page, setPage] = useState<Page>('home');
  const pageRef = useRef<Page>('home');
  const settingsOpen = page === 'settings';
  const [history, setHistory] = useState<JobHistoryEntry[]>([]);
  const [recovery, setRecovery] = useState<RecoveryState | undefined>(undefined);
  const [appVersion, setAppVersion] = useState('');
  const [settings, setSettings] = useState<ProviderSettings>({
    groqApiKey: '', cloudflareAccountId: '', cloudflareApiToken: ''
  });
  const [saved, setSaved] = useState(false);
  const [logs, setLogs] = useState<PipelineLog[]>([]);
  const [authProfile, setAuthProfile] = useState<AuthProfile | undefined>(undefined);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | undefined>(undefined);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>({ accelerator: DEFAULT_SHORTCUT, registered: false, wayland: false, message: 'Checking shortcut registration…' });
  const [hotkeyDraft, setHotkeyDraft] = useState(DEFAULT_SHORTCUT);
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [hotkeyTestState, setHotkeyTestState] = useState<'idle' | 'waiting' | 'passed' | 'failed'>('idle');
  const [hotkeyFeedback, setHotkeyFeedback] = useState<{ state: 'success' | 'error' | 'waiting'; message: string } | undefined>(undefined);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [behavior, setBehavior] = useState<BehaviorSettings>({ handsFree: false, controlStyle: 'visual', visionFallback: false });
  const [handsFree, setHandsFree] = useState<HandsFreeStatus>({ enabled: false, state: 'off', message: 'Hands-free is off.' });
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const segmentsRef = useRef<Blob[]>([]);
  const segmentTimerRef = useRef<number | undefined>(undefined);
  const rotatingRef = useRef(false);
  const capturePendingRef = useRef<Promise<void> | undefined>(undefined);
  const stopRequestedRef = useRef(false);
  const cancelledCaptureRef = useRef(false);
  const finalizedRef = useRef(false);
  const finalizeCaptureRef = useRef<((finalSegment?: Blob) => void) | undefined>(undefined);
  finalizeCaptureRef.current = (finalSegment?: Blob) => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    if (segmentTimerRef.current !== undefined) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = undefined;
    }
    if (cancelledCaptureRef.current) {
      segmentsRef.current = [];
      chunksRef.current = [];
      recorderRef.current = undefined;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = undefined;
      return;
    }
    const recorder = recorderRef.current;
    const lastSegment = finalSegment ?? (recorder ? new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }) : undefined);
    const segments = [...segmentsRef.current, ...(lastSegment && lastSegment.size > 0 ? [lastSegment] : [])];
    segmentsRef.current = [];
    const totalBytes = segments.reduce((total, segment) => total + segment.size, 0);
    window.voiceRouter.logCapture({
      event: 'capture.finalized',
      message: `Microphone audio finalized into ${segments.length} segment${segments.length === 1 ? '' : 's'}.`,
      data: { bytes: String(totalBytes), segments: String(segments.length), mimeType: segments[0]?.type || recorder?.mimeType || 'audio/webm' }
    });
    recorderRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    void Promise.all(segments.map(async (segment) => new Uint8Array(await segment.arrayBuffer())))
      .then((audioSegments) => window.voiceRouter.transcribeAudio(audioSegments))
      .catch(() => undefined);
  };
  const state = snapshot.state;
  useEffect(() => {
    if (!window.voiceRouter) return undefined;
    void window.voiceRouter.getSnapshot().then(setSnapshot);
    void window.voiceRouter.getAuthProfile().then(setAuthProfile).catch(() => setAuthProfile(undefined));
    void window.voiceRouter.getLogs().then(setLogs);
    void window.voiceRouter.getHotkey().then((status) => {
      setHotkeyStatus(status);
      setHotkeyDraft(status.accelerator);
    }).catch(() => undefined);
    const unsubscribeSnapshot = window.voiceRouter.subscribe(setSnapshot);
    // Settings and the Live log belong to the app window only; the overlay must never claim Settings is open.
    const unsubscribeSettings = IS_OVERLAY ? () => undefined : window.voiceRouter.onOpenSettings(() => navigate('settings'));
    const unsubscribeOpenLogs = IS_OVERLAY ? () => undefined : window.voiceRouter.onOpenLogs(() => navigate('activity'));
    let unsubscribeHistory: () => void = () => undefined;
    let unsubscribeRecovery: () => void = () => undefined;
    if (!IS_OVERLAY) {
      void window.voiceRouter.getHistory().then(setHistory).catch(() => undefined);
      void window.voiceRouter.getRecovery().then(setRecovery).catch(() => undefined);
      void window.voiceRouter.getAppInfo().then((info) => setAppVersion(info.version)).catch(() => undefined);
      unsubscribeHistory = window.voiceRouter.onHistory(setHistory);
      unsubscribeRecovery = window.voiceRouter.onRecovery(setRecovery);
    }
    const unsubscribeAuth = window.voiceRouter.onAuthProfile(setAuthProfile);
    const unsubscribeAuthRequired = window.voiceRouter.onAuthRequired(() => {
      setAuthProfile(undefined);
      setAuthError('Sign in with Google to continue using Tawny.');
    });
    const unsubscribeUpdate = window.voiceRouter.onUpdateState(setUpdateNotice);
    void window.voiceRouter.getBehavior().then(setBehavior).catch(() => undefined);
    void window.voiceRouter.getHandsFree().then(setHandsFree).catch(() => undefined);
    const unsubscribeHandsFree = window.voiceRouter.onHandsFree(setHandsFree);
    const unsubscribeLogs = window.voiceRouter.onLog((entry) => setLogs((current) => [...current.slice(-199), entry]));
    return () => {
      unsubscribeSnapshot();
      unsubscribeSettings();
      unsubscribeOpenLogs();
      unsubscribeAuth();
      unsubscribeAuthRequired();
      unsubscribeUpdate();
      unsubscribeHandsFree();
      unsubscribeLogs();
      unsubscribeHistory();
      unsubscribeRecovery();
    };
  }, []);
  // The global shortcut is held back only while Settings is on screen and focused (so recording a new key
  // never starts a job). On any other page, or with the window in the background, it always works.
  useEffect(() => {
    if (IS_OVERLAY || !window.voiceRouter) return undefined;
    const sync = (): void => window.voiceRouter.setSettingsOpen(page === 'settings' && document.hasFocus());
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
    };
  }, [page]);
  useEffect(() => {
    if (!authProfile) {
      setSettings({ groqApiKey: '', cloudflareAccountId: '', cloudflareApiToken: '' });
      return;
    }
    void window.voiceRouter.getSettings().then(setSettings).catch((error: unknown) => {
      setAuthError(error instanceof Error ? error.message : 'Provider settings could not be loaded.');
    });
  }, [authProfile]);
  useEffect(() => {
    if (!settingsOpen) return;
    void window.voiceRouter?.getHotkey().then((status) => {
      setHotkeyStatus(status);
      setHotkeyDraft(status.accelerator);
    }).catch(() => undefined);
  }, [settingsOpen]);
  useEffect(() => {
    if (!IS_OVERLAY || state !== 'arming' || snapshot.source === 'wake' || recorderRef.current || capturePendingRef.current) return undefined;
    const capture = async (): Promise<void> => {
      finalizedRef.current = false;
      cancelledCaptureRef.current = false;
      stopRequestedRef.current = false;
      window.voiceRouter.logCapture({ event: 'capture.permission.request', message: 'Requesting microphone access.' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      streamRef.current = stream;
      chunksRef.current = [];
      segmentsRef.current = [];
      rotatingRef.current = false;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This system does not support WebM microphone recording.');
      const startSegment = (): void => {
        const recorder = new MediaRecorder(stream, { mimeType });
        recorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          if (segmentTimerRef.current !== undefined) {
            window.clearTimeout(segmentTimerRef.current);
            segmentTimerRef.current = undefined;
          }
          const segment = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType });
          chunksRef.current = [];
          if (rotatingRef.current && !stopRequestedRef.current) {
            rotatingRef.current = false;
            if (segment.size > 0) segmentsRef.current.push(segment);
            startSegment();
            return;
          }
          rotatingRef.current = false;
          finalizeCaptureRef.current?.(segment);
        };
        recorder.onerror = () => window.voiceRouter.logCapture({ level: 'error', event: 'capture.recorder.error', message: 'The microphone recorder reported an error.' });
        recorder.start(250);
        window.voiceRouter.logCapture({ event: 'capture.recording', message: 'Microphone recorder segment started.', data: { mimeType, segmentMs: String(RECORDING_SEGMENT_MS) } });
        segmentTimerRef.current = window.setTimeout(() => {
          if (recorderRef.current === recorder && recorder.state === 'recording' && !stopRequestedRef.current) {
            rotatingRef.current = true;
            recorder.stop();
          }
        }, RECORDING_SEGMENT_MS);
        if (stopRequestedRef.current) recorder.stop();
      };
      startSegment();
    };
    capturePendingRef.current = capture().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Microphone permission was denied.';
      window.voiceRouter.logCapture({ level: 'error', event: 'capture.failure', message });
      setSnapshot((current) => ({ ...current, state: 'failed', message: `Microphone unavailable: ${message}` }));
    }).finally(() => {
      capturePendingRef.current = undefined;
      if (stopRequestedRef.current && recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
    });
    return undefined;
  }, [state]);
  useEffect(() => {
    if (!IS_OVERLAY || state !== 'finalizing' || snapshot.source === 'wake') return undefined;
    stopRequestedRef.current = true;
    if (!recorderRef.current) {
      window.voiceRouter.logCapture({ event: 'capture.stop.pending', message: 'Waiting for microphone permission before finalizing.' });
      return undefined;
    }
    const recorder = recorderRef.current;
    if (recorder.state !== 'recording') return undefined;
    recorder.stop();
    return undefined;
  }, [state]);
  useEffect(() => {
    if (!IS_OVERLAY || state !== 'cancelled' || snapshot.source === 'wake') return undefined;
    cancelledCaptureRef.current = true;
    stopRequestedRef.current = true;
    rotatingRef.current = false;
    if (segmentTimerRef.current !== undefined) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = undefined;
    }
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.stop();
    } else {
      recorderRef.current = undefined;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = undefined;
      segmentsRef.current = [];
      chunksRef.current = [];
    }
    return undefined;
  }, [state]);
  const label = useMemo(() => {
    const isImage = snapshot.intent === 'image_generate' || !!snapshot.imageDataUrl;
    const isCodeOrQuery = snapshot.intent === 'text_query';
    const isRewrite = snapshot.intent === 'text_rewrite';
    const isControl = snapshot.intent === 'computer_control';
    const isWake = snapshot.source === 'wake';

    const handlingTitle = isControl
      ? 'Working on it'
      : isImage
      ? 'Generating image'
      : isCodeOrQuery
      ? 'Writing code'
      : isRewrite
      ? 'Rewriting text'
      : 'Generating response';

    const handlingSubtitle = isControl
      ? snapshot.message ?? 'Controlling your computer'
      : isImage
      ? 'Cloudflare Flux'
      : isCodeOrQuery
      ? 'Cloudflare Llama'
      : isRewrite
      ? 'Cloudflare CLEF'
      : 'Cloudflare AI';

    const doneTitle = isControl
      ? 'Done'
      : isImage
      ? 'Image ready'
      : isCodeOrQuery
      ? 'Code ready'
      : isRewrite
      ? 'Rewrite ready'
      : 'Dictation ready';

    const map: Record<string, [string, string]> = {
      idle: ['Ready', displayShortcut(hotkeyStatus.accelerator)],
      arming: ['Listening', 'Speak now'],
      recording: isWake ? ['Listening', 'Say “Tawny send it” to finish'] : ['Listening', 'Release to send'],
      finalizing: ['Finishing', 'Saving audio'],
      transcribing: ['Transcribing', 'Groq Whisper'],
      gating: ['Routing', 'Evaluating wake phrase'],
      deciding: ['Routing', 'Understanding request'],
      confirming: snapshot.confirmMessage ? ['Are you sure?', snapshot.confirmMessage] : ['Generate image?', 'Press Enter to confirm'],
      handling: [handlingTitle, handlingSubtitle],
      injecting: ['Pasting', 'Returning to your app'],
      done: [doneTitle, isControl ? snapshot.message ?? 'Finished' : snapshot.message?.includes('clipboard') ? snapshot.message : isImage ? 'Preview generated locally' : 'Pasted at cursor'],
      failed: ['Something went wrong', snapshot.message ?? 'Retry with hotkey'],
      cancelled: ['Cancelled', 'Nothing was sent']
    };
    return map[state] ?? ['Tawny', ''];
  }, [state, snapshot.intent, snapshot.source, snapshot.message, snapshot.confirmMessage, snapshot.imageDataUrl, hotkeyStatus.accelerator]);

  const isListening = state === 'recording' || state === 'arming';
  const isBusy = ['transcribing', 'gating', 'deciding', 'handling', 'injecting', 'finalizing'].includes(state);
  async function updateBehavior(patch: Partial<BehaviorSettings>): Promise<void> {
    const next = { ...behavior, ...patch };
    setBehavior(next);
    try {
      setBehavior(await window.voiceRouter.saveBehavior(next));
    } catch {
      setBehavior(behavior);
    }
  }
  function navigate(next: Page): void {
    if (pageRef.current === 'settings' && next !== 'settings') {
      setRecordingHotkey(false);
      void window.voiceRouter?.closeSettings();
    }
    pageRef.current = next;
    setPage(next);
  }

  async function saveSettings(): Promise<void> {
    if (!window.voiceRouter) return;
    await window.voiceRouter.saveSettings(settings);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  }

  function captureShortcut(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    event.preventDefault();
    if (event.key === 'Escape') {
      void window.voiceRouter?.setHotkeyCaptureMode(false);
      setRecordingHotkey(false);
      setHotkeyFeedback({ state: 'error', message: 'Shortcut change cancelled.' });
      return;
    }
    const accelerator = acceleratorFromKeyEvent(event);
    if (!accelerator) {
      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
        void window.voiceRouter?.setHotkeyCaptureMode(false);
        setRecordingHotkey(false);
        setHotkeyFeedback({ state: 'error', message: 'Use at least one modifier and one non-modifier key.' });
      }
      return;
    }
    void window.voiceRouter?.setHotkeyCaptureMode(false);
    setHotkeyDraft(accelerator);
    setRecordingHotkey(false);
    setHotkeyFeedback(undefined);
    setHotkeyTestState('idle');
  }

  async function saveShortcut(): Promise<void> {
    setHotkeyFeedback(undefined);
    setHotkeyTestState('idle');
    try {
      await window.voiceRouter?.setHotkeyCaptureMode(false);
      const status = await window.voiceRouter?.saveHotkey(hotkeyDraft);
      if (!status) return;
      setHotkeyStatus(status);
      setHotkeyDraft(status.accelerator);
      setHotkeyTestState('idle');
      setHotkeyFeedback({
        state: status.registered ? 'success' : 'error',
        message: status.registered ? 'Shortcut saved. Use Test key to confirm it triggers.' : 'Shortcut saved, but the system did not confirm registration. Test it or follow the setup hint above.'
      });
    } catch (error) {
      setHotkeyFeedback({ state: 'error', message: error instanceof Error ? error.message : 'Shortcut could not be saved.' });
    }
  }

  async function testShortcut(): Promise<void> {
    setHotkeyFeedback(undefined);
    setHotkeyTestState('waiting');
    setHotkeyFeedback({ state: 'waiting', message: `Press ${displayShortcut(hotkeyStatus.accelerator)} now…` });
    try {
      const result = await window.voiceRouter?.testHotkey();
      if (!result) {
        setHotkeyTestState('failed');
        setHotkeyFeedback({ state: 'error', message: 'The shortcut test could not start.' });
        return;
      }
      setHotkeyTestState(result.success ? 'passed' : 'failed');
      setHotkeyFeedback({ state: result.success ? 'success' : 'error', message: result.message });
    } catch (error) {
      setHotkeyTestState('failed');
      const message = error instanceof Error ? error.message : 'The shortcut test failed.';
      setHotkeyFeedback({ state: 'error', message });
    }
  }

  async function beginShortcutCapture(): Promise<void> {
    setHotkeyFeedback(undefined);
    try {
      await window.voiceRouter?.setHotkeyCaptureMode(true);
      setRecordingHotkey(true);
    } catch (error) {
      setHotkeyFeedback({ state: 'error', message: error instanceof Error ? error.message : 'Shortcut capture could not start.' });
    }
  }

  async function copyCompositorCommand(): Promise<void> {
    setHotkeyFeedback(undefined);
    try {
      await window.voiceRouter?.copyCompositorCommand();
      setHotkeyFeedback({ state: 'success', message: 'Compositor command copied.' });
    } catch (error) {
      setHotkeyFeedback({ state: 'error', message: error instanceof Error ? error.message : 'The compositor command could not be copied.' });
    }
  }

  async function installUpdate(): Promise<void> {
    setInstallingUpdate(true);
    try {
      await window.voiceRouter?.installUpdate();
    } catch (error) {
      setInstallingUpdate(false);
      setUpdateNotice({ state: 'error', message: error instanceof Error ? error.message : 'The update could not be installed.' });
    }
  }

  async function handleGoogleSignIn(): Promise<void> {
    if (!window.voiceRouter || authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    try {
      const profile = await window.voiceRouter.signIn();
      setAuthProfile(profile);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Google sign-in could not be completed. Check your connection and try again.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    await window.voiceRouter?.signOut();
    navigate('home');
  }

  const updateBanner = updateNotice ? (
    <aside className={`update-strip update-${updateNotice.state}`} role="status">
      <Download size={14} />
      <span><strong>{updateNotice.state === 'ready' ? 'Update ready.' : updateNotice.state === 'error' ? 'Update check.' : 'Update.'}</strong> {updateNotice.message}</span>
      {(updateNotice.state === 'manual' || updateNotice.state === 'ready') && <button className="btn btn-small btn-ink" disabled={installingUpdate} onClick={() => void (updateNotice.state === 'ready' ? installUpdate() : window.voiceRouter?.openReleasePage())}>{updateNotice.state === 'ready' ? installingUpdate ? 'Restarting…' : 'Restart now' : 'View release'}</button>}
      <button className="icon-btn" aria-label="Dismiss update notice" onClick={() => setUpdateNotice(undefined)}><X size={13} /></button>
    </aside>
  ) : undefined;

  const settingsSections: Array<[string, string]> = [['set-shortcut', 'Shortcut'], ['set-handsfree', 'Hands-free'], ['set-providers', 'Providers'], ['set-about', 'About']];
  const settingsPage = (
    <div className="settings-page">
      <nav className="set-index" aria-label="Settings sections">
        {settingsSections.map(([id, title]) => (
          <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{title}</button>
        ))}
      </nav>
      <div className="set-scroll">
        <SettingsSection id="set-shortcut" title="Recording shortcut" hint="Press it anywhere to talk to Tawny." aside={<span className={`hotkey-state ${hotkeyStatus.registered ? 'is-registered' : 'needs-compositor'}`}>{hotkeyStatus.registered ? 'Registered' : hotkeyStatus.wayland ? 'Compositor setup' : 'Not registered'}</span>}>
          <div className="hotkey-controls">
            <kbd className="hotkey-preview">{displayShortcut(hotkeyDraft)}</kbd>
            <button className="hotkey-secondary" onClick={() => void beginShortcutCapture()}>Record keys</button>
            <button className="hotkey-secondary hotkey-test" onClick={() => void testShortcut()} disabled={hotkeyTestState === 'waiting'}>{hotkeyTestState === 'waiting' ? 'Listening…' : 'Test key'}</button>
            <button className="hotkey-save" onClick={() => void saveShortcut()}>Save shortcut</button>
          </div>
          {recordingHotkey && <button className="hotkey-capture" onKeyDown={captureShortcut} onBlur={() => { setRecordingHotkey(false); void window.voiceRouter?.setHotkeyCaptureMode(false); }} autoFocus>Press your shortcut now · Esc cancels</button>}
          <p className="hotkey-status-copy" role="status">{hotkeyStatus.message}</p>
          {hotkeyStatus.wayland && hotkeyStatus.compositorCommand && <div className="compositor-command"><div><span>Wayland fallback command</span><small>Bind this in your compositor’s keyboard-shortcut settings if the portal shortcut doesn’t trigger.</small><code title={hotkeyStatus.compositorCommand}>{hotkeyStatus.compositorCommand}</code></div><button className="hotkey-secondary" onClick={() => void copyCompositorCommand()}>Copy</button></div>}
          {hotkeyFeedback && <p className={`hotkey-feedback is-${hotkeyFeedback.state}`} role={hotkeyFeedback.state === 'error' ? 'alert' : 'status'}>
            {hotkeyFeedback.state === 'waiting' ? <LoaderCircle size={12} className="signin-spinner" /> : hotkeyFeedback.state === 'success' ? <ShieldCheck size={12} /> : <X size={12} />}
            <span>{hotkeyFeedback.message}</span>
          </p>}
        </SettingsSection>
        <SettingsSection id="set-handsfree" title="Hands-free and voice control" hint="Say “Hey Tawny”, then your request. Windows only." aside={<span className={`hotkey-state ${handsFree.state === 'listening' ? 'is-registered' : 'needs-compositor'}`}>{handsFree.state === 'listening' ? 'Listening' : handsFree.state === 'off' ? 'Off' : handsFree.state === 'error' ? 'Problem' : handsFree.state === 'paused' ? 'Paused' : 'Starting'}</span>}>
          <label className="toggle-row"><input type="checkbox" checked={behavior.handsFree} onChange={(event) => void updateBehavior({ handsFree: event.target.checked })} /><span><strong>Listen for “Hey Tawny”</strong><small>Keeps the microphone open while Tawny runs. The wake phrase is recognized on this PC; audio goes to Groq only after it.</small></span></label>
          <p className={`hotkey-status-copy ${handsFree.state === 'error' ? 'is-error' : ''}`} role="status">{handsFree.message}</p>
          <label className="toggle-row"><input type="checkbox" checked={behavior.controlStyle === 'visual'} onChange={(event) => void updateBehavior({ controlStyle: event.target.checked ? 'visual' : 'fast' })} /><span><strong>Show the cursor moving</strong><small>When off, Tawny opens things directly without animating the mouse. Moving the mouse stops any action.</small></span></label>
          <label className="toggle-row"><input type="checkbox" checked={behavior.visionFallback} onChange={(event) => void updateBehavior({ visionFallback: event.target.checked })} /><span><strong>Use screenshots when an app cannot be read</strong><small>Off by default. When on, a screenshot is sent to Cloudflare to find a button Tawny cannot otherwise see.</small></span></label>
        </SettingsSection>
        <SettingsSection id="set-providers" title="Providers" hint="Keys are encrypted with Windows secure storage and never written to logs.">
          <div className="settings-grid">
            {([
              ['groqApiKey', 'Groq API key', 'Whisper transcription'],
              ['cloudflareAccountId', 'Cloudflare account ID', 'Workers AI account'],
              ['cloudflareApiToken', 'Cloudflare API token', 'Understanding, writing and images']
            ] as const).map(([key, title, hint]) => <label className="field" key={key}><span>{title}</span><small>{hint}</small><input type={key.toLowerCase().includes('key') || key.toLowerCase().includes('token') ? 'password' : 'text'} value={settings[key]} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} placeholder="Not connected" autoComplete="off" /></label>)}
          </div>
          <div className="settings-footer"><span className={saved ? 'saved' : ''}>{saved ? 'Saved securely' : 'Credentials stay on this device.'}</span><button className="btn btn-primary" onClick={() => void saveSettings()}>Save credentials</button></div>
        </SettingsSection>
        <SettingsSection id="set-about" title="About" hint="Early preview. Updates download in the background and install when Tawny is idle.">
          <div className="about-row">
            <span className="kicker">Version</span><span className="mono">{appVersion || '—'}</span>
            <button className="btn btn-quiet" onClick={() => void window.voiceRouter?.openReleasePage()}><ExternalLink size={12} /> Release notes</button>
          </div>
        </SettingsSection>
      </div>
    </div>
  );

  return (
    <main className={`app-shell state-${state} ${IS_OVERLAY ? 'overlay-page' : 'main-page'}`}>
      {!IS_OVERLAY ? (
        authProfile ? (
          <Shell
            page={page}
            onNavigate={navigate}
            profile={authProfile}
            handsFree={handsFree}
            onToggleHandsFree={() => void updateBehavior({ handsFree: !behavior.handsFree })}
            recovery={recovery}
            version={appVersion}
            onSignOut={() => void handleSignOut()}
            banner={updateBanner}
          >
            {page === 'home' && <HomePage
              profile={authProfile}
              shortcut={hotkeyStatus.accelerator}
              shortcutRegistered={hotkeyStatus.registered}
              behavior={behavior}
              handsFree={handsFree}
              history={history}
              recovery={recovery}
              onBehavior={(patch) => void updateBehavior(patch)}
              onNavigate={navigate}
              onBackground={() => void window.voiceRouter?.enterBackground()}
            />}
            {page === 'recordings' && <RecordingsPage state={recovery} />}
            {page === 'activity' && <ActivityPage logs={logs} shortcut={hotkeyStatus.accelerator} />}
            {page === 'settings' && settingsPage}
          </Shell>
        ) : (
          <div className="signed-out">
            <header className="titlebar titlebar-floating">
              <div className="brand"><img className="brand-mark" src="./tawny-mark.svg" alt="" /><span>Tawny</span></div>
              <div className="window-controls">
                <button aria-label="Minimize" onClick={() => void window.voiceRouter?.windowAction('minimize')}><Minus size={14} /></button>
                <button aria-label="Close to tray" onClick={() => void window.voiceRouter?.windowAction('hide')}><X size={14} /></button>
              </div>
            </header>
            <section className="welcome-page">
              <div className="welcome-copy">
                <span className="eyebrow">PRIVATE DESKTOP VOICE LAYER</span>
                <h1>Speak naturally.<br /><em>Work precisely.</em></h1>
                <p>Tawny listens for your shortcut or “Hey Tawny”, understands what you mean, and returns the result to the app already in focus.</p>
                <p className="signin-trust-note"><ShieldCheck size={14} /> Sign in once on this device. Your session is kept in secure system storage.</p>
              </div>
              <div className="signin-column">
                <div className="signin-card">
                  <div className="signin-wave" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>
                  <p className="eyebrow">YOUR VOICE, YOUR WORKSPACE</p>
                  <h2>Sign in to Tawny</h2>
                  <p className="signin-description">Use your Google account to unlock your desktop voice assistant.</p>
                  <button className="google-signin-button" onClick={() => void handleGoogleSignIn()} disabled={authBusy}>
                    {authBusy ? <LoaderCircle className="signin-spinner" size={17} /> : <GoogleMark />}
                    {authBusy ? 'Waiting for Google…' : 'Continue with Google'}
                    {!authBusy && <ExternalLink size={14} className="signin-external-icon" />}
                  </button>
                  {authBusy && <button className="signin-cancel" onClick={() => { void window.voiceRouter?.cancelSignIn(); setAuthBusy(false); }}>Cancel sign-in</button>}
                  {authError && <p className="signin-error" role="alert">{authError}</p>}
                  <p className="signin-footnote"><ShieldCheck size={13} /> Google handles your password. Tawny stores only an encrypted Firebase session.</p>
                </div>
              </div>
            </section>
          </div>
        )
      ) : (
        <div className="tawny-overlay-wrapper">
          {snapshot.source === 'wake' && isListening ? (
            <div className="tawny-orb" role="status" aria-label="Tawny is listening" style={{ ['--level' as string]: String(Math.min(1, snapshot.rms)) }}>
              <span className="orb-ring" />
              <span className="orb-core"><Mic size={15} strokeWidth={2} /></span>
            </div>
          ) : (
          <div className="tawny-floating-pill">
            <div className="notch-handle" />

            {/* Brand Section */}
            <div className="pill-brand">
              <div className="brand-badge">
                <img className="brand-logo" src="./tawny-mark.svg" alt="Tawny" />
              </div>
              <span className="brand-title">Tawny</span>
            </div>

            <div className="pill-divider" />

            {/* Status & Dynamic Info Section */}
            <div className="pill-status-area">
              <div className="status-indicator-box">
                {isListening ? (
                  <div className="listening-pulse">
                    <span className="pulse-dot" />
                  </div>
                ) : isBusy ? (
                  <LoaderCircle className="status-spinner" size={17} />
                ) : state === 'done' ? (
                  <div className="status-badge-circle done">
                    <span className="inner-dot" />
                  </div>
                ) : state === 'failed' ? (
                  <div className="status-badge-circle error">
                    <span className="inner-dot" />
                  </div>
                ) : (
                  <div className="status-badge-circle ready">
                    <span className="inner-dot" />
                  </div>
                )}
              </div>
              <div className="status-text-stack">
                <strong className="status-headline">{label[0]}</strong>
                <span className="status-subline">{label[1]}</span>
              </div>
              <Sparkles className="pill-sparkle" size={15} />
            </div>

            <div className="pill-divider" />

            {/* Preview & Action Section */}
            <div className="pill-action-area">
              {snapshot.imageDataUrl ? (
                <img className="pill-preview-image" src={snapshot.imageDataUrl} alt="Preview" />
              ) : (
                <div className="pill-preview-placeholder">
                  {snapshot.intent === 'computer_control' ? (
                    <MousePointer2 size={16} strokeWidth={1.75} />
                  ) : snapshot.intent === 'text_query' ? (
                    <CodeIcon size={16} strokeWidth={1.75} />
                  ) : snapshot.intent === 'text_rewrite' ? (
                    <FileTextIcon size={16} strokeWidth={1.75} />
                  ) : (
                    <ImageIcon size={16} strokeWidth={1.75} />
                  )}
                </div>
              )}
              {snapshot.confirmMessage ? (
                <div className="confirm-group">
                  <button className="confirm-btn" onClick={() => window.voiceRouter?.respondConfirm(true)}>
                    Confirm <kbd>Enter</kbd>
                  </button>
                  <button className="confirm-cancel" onClick={() => window.voiceRouter?.respondConfirm(false)}>Cancel</button>
                </div>
              ) : state === 'confirming' ? (
                <button className="confirm-btn" onClick={() => window.voiceRouter?.send('CONFIRM')}>
                  Confirm <kbd>Enter</kbd>
                </button>
              ) : (
                <div className="pill-ready-tag">
                  <span>{state === 'recording' ? 'REC' : state === 'finalizing' || state === 'transcribing' ? 'WAIT' : isBusy ? 'WORKING' : 'READY'}</span>
                  <ChevronRight size={11} strokeWidth={2.5} />
                </div>
              )}
            </div>
          </div>
          )}
        </div>
      )}
    </main>
  );
}

function GoogleMark(): ReactElement {
  return <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.4 0 24 0 14.7 0 6.6 5.3 2.7 13.1l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5Z" />
    <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.6 2.9-2.2 5.3-4.7 6.9l7.6 5.9c4.4-4.1 6.8-10.1 6.8-17.3Z" />
    <path fill="#FBBC05" d="M10.6 28.8c-.5-1.5-.8-3.1-.8-4.8s.3-3.3.8-4.8l-7.9-6.1C1 16.4 0 20.1 0 24s1 7.6 2.7 10.9l7.9-6.1Z" />
    <path fill="#34A853" d="M24 48c6.4 0 11.8-2.1 15.7-6.2l-7.6-5.9c-2.1 1.4-4.8 2.3-8.1 2.3-6.2 0-11.5-4.1-13.4-9.7l-7.9 6.1C6.6 42.7 14.7 48 24 48Z" />
  </svg>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
