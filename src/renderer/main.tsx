import { StrictMode, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronRight, Image as ImageIcon, LoaderCircle, Sparkles, ScrollText, Settings2, X, Keyboard, ShieldCheck, Code as CodeIcon, FileText as FileTextIcon } from 'lucide-react';
import type { OverlaySnapshot, PipelineLog, ProviderSettings } from '../shared/contracts';
import './styles.css';

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
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const capturePendingRef = useRef<Promise<void> | undefined>(undefined);
  const stopRequestedRef = useRef(false);
  const finalizedRef = useRef(false);
  const finalizeCaptureRef = useRef<(() => void) | undefined>(undefined);
  finalizeCaptureRef.current = () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const recorder = recorderRef.current;
    if (!recorder) return;
    const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    window.voiceRouter.logCapture({ event: 'capture.finalized', message: 'Microphone audio finalized.', data: { bytes: String(blob.size), mimeType: blob.type } });
    recorderRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    void blob.arrayBuffer().then((buffer) => window.voiceRouter.transcribeAudio(new Uint8Array(buffer))).catch(() => undefined);
  };
  const state = snapshot.state;
  useEffect(() => {
    if (!window.voiceRouter) return undefined;
    void window.voiceRouter.getSnapshot().then(setSnapshot);
    void window.voiceRouter.getSettings().then(setSettings);
    void window.voiceRouter.getLogs().then(setLogs);
    const unsubscribeSnapshot = window.voiceRouter.subscribe(setSnapshot);
    const unsubscribeSettings = window.voiceRouter.onOpenSettings(() => setSettingsOpen(true));
    const unsubscribeOpenLogs = window.voiceRouter.onOpenLogs(() => setLogsOpen(true));
    const unsubscribeBackground = window.voiceRouter.onBackgroundMode(() => setMainPage(false));
    const unsubscribeLogs = window.voiceRouter.onLog((entry) => setLogs((current) => [...current.slice(-199), entry]));
    return () => {
      unsubscribeSnapshot();
      unsubscribeSettings();
      unsubscribeOpenLogs();
      unsubscribeBackground();
      unsubscribeLogs();
    };
  }, []);
  useEffect(() => {
    if (state !== 'arming' || recorderRef.current || capturePendingRef.current) return undefined;
    const capture = async (): Promise<void> => {
      finalizedRef.current = false;
      stopRequestedRef.current = false;
      window.voiceRouter.logCapture({ event: 'capture.permission.request', message: 'Requesting microphone access.' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This system does not support WebM microphone recording.');
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => finalizeCaptureRef.current?.();
      recorder.onerror = () => window.voiceRouter.logCapture({ level: 'error', event: 'capture.recorder.error', message: 'The microphone recorder reported an error.' });
      recorder.start(250);
      window.voiceRouter.logCapture({ event: 'capture.recording', message: 'Microphone recorder started.', data: { mimeType } });
      if (stopRequestedRef.current) recorder.stop();
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
              <div className="welcome-actions">
                <button className="launch-button" onClick={() => { setMainPage(false); void window.voiceRouter?.enterBackground(); }}>
                  Run in background <KeyboardIcon />
                </button>
                <button className="secondary-button" onClick={() => setSettingsOpen(true)}>
                  <SettingsIcon /> Configure providers
                </button>
              </div>
            </div>
            <div className="welcome-preview">
              <div className="preview-orbit orbit-one" />
              <div className="preview-orbit orbit-two" />
              <div className="preview-card">
                <img src="/tawny-mark.svg" alt="" />
                <strong>Ready when you are</strong>
                <span>Ctrl + Alt + Space</span>
              </div>
            </div>
          </section>
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

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
