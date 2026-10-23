import { StrictMode, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronRight, Image as ImageIcon, LoaderCircle, Sparkles, ScrollText, Settings2, X, Keyboard, ShieldCheck, Code as CodeIcon, FileText as FileTextIcon, LogOut, UserRound, ExternalLink, Download } from 'lucide-react';
import type { AuthProfile, OverlaySnapshot, PipelineLog, ProviderSettings, UpdateNotice } from '../shared/contracts';
import './styles.css';

const RECORDING_SEGMENT_MS = 60_000;

function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<OverlaySnapshot>({ state: 'idle', elapsedMs: 0, rms: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ProviderSettings>({
    groqApiKey: '', cloudflareAccountId: '', cloudflareApiToken: ''
  });
  const [saved, setSaved] = useState(false);
  const [mainPage, setMainPage] = useState(true);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<PipelineLog[]>([]);
  const [authProfile, setAuthProfile] = useState<AuthProfile | undefined>(undefined);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | undefined>(undefined);
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
    const unsubscribeSnapshot = window.voiceRouter.subscribe(setSnapshot);
    const unsubscribeSettings = window.voiceRouter.onOpenSettings(() => setSettingsOpen(true));
    const unsubscribeOpenLogs = window.voiceRouter.onOpenLogs(() => setLogsOpen(true));
    const unsubscribeBackground = window.voiceRouter.onBackgroundMode(() => setMainPage(false));
    const unsubscribeAuth = window.voiceRouter.onAuthProfile(setAuthProfile);
    const unsubscribeAuthRequired = window.voiceRouter.onAuthRequired(() => {
      setAuthProfile(undefined);
      setMainPage(true);
      setAuthError('Sign in with Google to continue using Tawny.');
    });
    const unsubscribeUpdate = window.voiceRouter.onUpdateState(setUpdateNotice);
    const unsubscribeLogs = window.voiceRouter.onLog((entry) => setLogs((current) => [...current.slice(-199), entry]));
    return () => {
      unsubscribeSnapshot();
      unsubscribeSettings();
      unsubscribeOpenLogs();
      unsubscribeBackground();
      unsubscribeAuth();
      unsubscribeAuthRequired();
      unsubscribeUpdate();
      unsubscribeLogs();
    };
  }, []);
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
    if (state !== 'arming' || recorderRef.current || capturePendingRef.current) return undefined;
    const capture = async (): Promise<void> => {
      finalizedRef.current = false;
      cancelledCaptureRef.current = false;
      stopRequestedRef.current = false;
      window.voiceRouter.logCapture({ event: 'capture.permission.request', message: 'Requesting microphone access.' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
    if (state !== 'finalizing') return undefined;
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
    if (state !== 'cancelled') return undefined;
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

    const handlingTitle = isImage
      ? 'Generating image'
      : isCodeOrQuery
      ? 'Writing code'
      : isRewrite
      ? 'Rewriting text'
      : 'Generating response';

    const handlingSubtitle = isImage
      ? 'Cloudflare Flux'
      : isCodeOrQuery
      ? 'Cloudflare Llama'
      : isRewrite
      ? 'Cloudflare CLEF'
      : 'Cloudflare AI';

    const doneTitle = isImage
      ? 'Image ready'
      : isCodeOrQuery
      ? 'Code ready'
      : isRewrite
      ? 'Rewrite ready'
      : 'Dictation ready';

    const map: Record<string, [string, string]> = {
      idle: ['Ready', 'Ctrl + Alt + Space'],
      arming: ['Listening', 'Speak now'],
      recording: ['Listening', 'Release to send'],
      finalizing: ['Finishing', 'Saving audio'],
      transcribing: ['Transcribing', 'Groq Whisper'],
      gating: ['Routing', 'Evaluating wake phrase'],
      deciding: ['Routing', 'Understanding request'],
      confirming: ['Generate image?', 'Press Enter to confirm'],
      handling: [handlingTitle, handlingSubtitle],
      injecting: ['Pasting', 'Returning to your app'],
      done: [doneTitle, isImage ? 'Preview generated locally' : 'Pasted at cursor'],
      failed: ['Something went wrong', snapshot.message ?? 'Retry with hotkey'],
      cancelled: ['Cancelled', 'Nothing was sent']
    };
    return map[state] ?? ['Tawny', ''];
  }, [state, snapshot.intent, snapshot.message, snapshot.imageDataUrl]);

  const isListening = state === 'recording' || state === 'arming';
  const isBusy = ['transcribing', 'gating', 'deciding', 'handling', 'injecting', 'finalizing'].includes(state);
  async function saveSettings(): Promise<void> {
    if (!window.voiceRouter) return;
    await window.voiceRouter.saveSettings(settings);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  }

  async function handleGoogleSignIn(): Promise<void> {
    if (!window.voiceRouter || authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    try {
      const profile = await window.voiceRouter.signIn();
      setAuthProfile(profile);
      setAccountMenuOpen(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Google sign-in could not be completed. Check your connection and try again.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    await window.voiceRouter?.signOut();
    setAccountMenuOpen(false);
    setMainPage(true);
  }

  return (
    <main className={`app-shell state-${state} ${mainPage ? 'main-page' : 'overlay-page'}`}>
      {mainPage ? (
        <>
          <header className="topbar">
            <div className="brand">
              <img className="brand-mark" src="/tawny-mark.svg" alt="" />
              <span>Tawny</span>
            </div>
            <div className="top-actions">
              <span className="status-dot" />
              <span className="status-label">READY</span>
              <button className="main-settings-button" onClick={() => setLogsOpen(true)}><ScrollText size={13} /> Live log</button>
              <button className="main-settings-button" onClick={() => setSettingsOpen(true)}><SettingsIcon /> Settings</button>
            </div>
          </header>
          <section className="welcome-page">
            <div className="welcome-copy">
              <span className="eyebrow">PRIVATE DESKTOP VOICE LAYER</span>
              <h1>Speak naturally.<br /><em>Work precisely.</em></h1>
              <p>Tawny listens for your shortcut, understands what you mean, and returns the result to the app already in focus.</p>
              {authProfile ? <div className="welcome-actions">
                <button className="launch-button" onClick={() => { setMainPage(false); void window.voiceRouter?.enterBackground(); }}>
                  Run in background <KeyboardIcon />
                </button>
                <button className="secondary-button" onClick={() => setSettingsOpen(true)}>
                  <SettingsIcon /> Configure providers
                </button>
              </div> : <p className="signin-trust-note"><ShieldCheck size={14} /> Sign in once on this device. Your Firebase session is kept in secure system storage.</p>}
            </div>
            {authProfile ? <div className="welcome-preview">
              <div className="preview-orbit orbit-one" />
              <div className="preview-orbit orbit-two" />
              <div className="preview-card">
                <img src="/tawny-mark.svg" alt="" />
                <strong>Ready when you are</strong>
                <span>Ctrl + Alt + Space</span>
              </div>
            </div> : <div className="signin-column">
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
            </div>}
          </section>
          {authProfile && <div className="account-anchor">
            <button className="account-button" title={authProfile.email} aria-label={`Account: ${authProfile.email}`} aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((open) => !open)}>
              <span className="account-avatar">{authProfile.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="account-hover-email">{authProfile.email}</span>
            </button>
            {accountMenuOpen && <div className="account-menu" role="menu">
              <span className="account-menu-label">SIGNED IN AS</span>
              <strong>{authProfile.email}</strong>
              <button role="menuitem" onClick={() => void handleSignOut()}><LogOut size={14} /> Sign out</button>
            </div>}
          </div>}
          {updateNotice && <aside className={`update-notice update-${updateNotice.state}`} role="status">
            <div className="update-notice-icon"><Download size={15} /></div>
            <div className="update-notice-copy"><strong>{updateNotice.state === 'ready' ? 'Update ready' : updateNotice.state === 'error' ? 'Update check' : 'Early preview update'}</strong><span>{updateNotice.message}</span></div>
            {(updateNotice.state === 'manual' || updateNotice.state === 'ready') && <button className="update-action" onClick={() => void (updateNotice.state === 'ready' ? window.voiceRouter?.installUpdate() : window.voiceRouter?.openReleasePage())}>{updateNotice.state === 'ready' ? 'Restart' : 'View release'}</button>}
            <button className="update-dismiss" aria-label="Dismiss update notice" onClick={() => setUpdateNotice(undefined)}><X size={14} /></button>
          </aside>}
        </>
      ) : (
        <div className="tawny-overlay-wrapper">
          <div className="tawny-floating-pill">
            <div className="notch-handle" />

            {/* Brand Section */}
            <div className="pill-brand">
              <div className="brand-badge">
                <img className="brand-logo" src="/tawny-mark.svg" alt="Tawny" />
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
                  {snapshot.intent === 'text_query' ? (
                    <CodeIcon size={16} strokeWidth={1.75} />
                  ) : snapshot.intent === 'text_rewrite' ? (
                    <FileTextIcon size={16} strokeWidth={1.75} />
                  ) : (
                    <ImageIcon size={16} strokeWidth={1.75} />
                  )}
                </div>
              )}
              {state === 'confirming' ? (
                <button className="confirm-btn" onClick={() => window.voiceRouter?.send('CONFIRM')}>
                  Confirm <kbd>Enter</kbd>
                </button>
              ) : (
                <div className="pill-ready-tag">
                  <span>{state === 'recording' ? 'REC' : state === 'finalizing' || state === 'transcribing' ? 'WAIT' : 'READY'}</span>
                  <ChevronRight size={11} strokeWidth={2.5} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {settingsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSettingsOpen(false); }}>
        <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="settings-heading"><div><p className="eyebrow">TAWNY / SETTINGS</p><h2 id="settings-title">Connect your providers</h2><p>Keys are encrypted with Windows secure storage and never written to logs.</p></div><button className="close-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={17} /></button></div>
          <div className="settings-grid">
            {([
              ['groqApiKey', 'Groq API key', 'Used for Whisper transcription'],
              ['cloudflareAccountId', 'Cloudflare account ID', 'Workers AI account identifier'],
              ['cloudflareApiToken', 'Cloudflare API token', 'Workers AI inference and image generation']
            ] as const).map(([key, title, hint]) => <label className="field" key={key}><span>{title}</span><small>{hint}</small><input type={key.toLowerCase().includes('key') || key.toLowerCase().includes('token') ? 'password' : 'text'} value={settings[key]} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} placeholder="Not connected" autoComplete="off" /></label>)}
          </div>
          <div className="settings-footer"><span className={saved ? 'saved' : ''}>{saved ? 'Saved securely' : 'Credentials stay on this device.'}</span><button className="save-button" onClick={() => void saveSettings()}>Save credentials</button></div>
        </section>
      </div>}
      {logsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setLogsOpen(false); }}>
        <section className="logs-panel" role="dialog" aria-modal="true" aria-labelledby="logs-title">
          <div className="settings-heading"><div><p className="eyebrow">TAWNY / DIAGNOSTICS</p><h2 id="logs-title">Live pipeline log</h2><p>Every stage transition is recorded locally. Secrets and transcript contents are redacted.</p></div><button className="close-button" onClick={() => setLogsOpen(false)} aria-label="Close live log"><X size={17} /></button></div>
          <div className="log-list">{logs.length === 0 ? <p className="empty-log">No pipeline activity yet. Press Ctrl + Alt + Space to start a job.</p> : logs.map((entry, index) => <div className={`log-entry log-${entry.level}`} key={`${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span className="log-event">{entry.event}</span><span className="log-message">{entry.message}</span>{entry.durationMs !== undefined && <span className="log-duration">{entry.durationMs}ms</span>}</div>)}</div>
          <div className="settings-footer"><span>{logs.length} recent events · JSONL file is stored in the Tawny app data logs folder.</span><button className="save-button" onClick={() => setLogsOpen(false)}>Close log</button></div>
        </section>
      </div>}
    </main>
  );
}

function KeyboardIcon(): ReactElement {
  return <Keyboard size={13} aria-hidden="true" />;
}

function SettingsIcon(): ReactElement {
  return <Settings2 size={13} aria-hidden="true" />;
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
