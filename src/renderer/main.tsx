import { StrictMode, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, Keyboard, LoaderCircle, Mic, ScrollText, Settings2, ShieldCheck, X } from 'lucide-react';
import type { OverlaySnapshot, PipelineLog, ProviderSettings } from '../shared/contracts';
import './styles.css';

const bars = [18, 30, 46, 26, 38, 20];

function Waveform({ rms }: { rms: number }): ReactElement {
  return <div className="waveform" aria-label="Live microphone level">{bars.map((height, index) => (
    <span key={height} style={{ height: `${Math.max(8, height * (0.55 + rms))}px`, animationDelay: `${index * 70}ms` }} />
  ))}</div>;
}

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
  const label = useMemo(() => ({
    idle: ['Ready when you are', 'Ctrl + Alt + Space'],
    arming: ['Starting microphone', 'Preparing capture'],
    recording: ['Listening', 'Release or press the check to finish'],
    finalizing: ['Finishing capture', 'Saving audio securely'],
    transcribing: ['Transcribing', 'Converting speech to text'],
    gating: ['Checking wake phrase', 'Routing your words'],
    deciding: ['Deciding', 'Understanding the request'],
    confirming: ['Generate image?', 'Hotkey to confirm · 3s'],
    handling: ['Generating image', 'Keeping your original prompt'],
    injecting: ['Pasting at the caret', 'Returning focus to your app'],
    done: [snapshot.imageDataUrl ? 'Image ready' : 'Done', snapshot.imageDataUrl ? 'Preview generated locally' : 'Returned to your app'],
    failed: ['Something went wrong', snapshot.message ?? 'Retry from the tray'],
    cancelled: ['Cancelled', 'Nothing was sent']
  } as Record<string, [string, string]>)[state] ?? ['Tawny', ''], [state, snapshot.message]);

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
      <header className="topbar"><div className="brand"><img className="brand-mark" src="/tawny-mark.svg" alt="" /><span>Tawny</span></div><div className="top-actions"><span className="status-dot" /><span className="status-label">READY</span>{mainPage && <><button className="main-settings-button" onClick={() => setLogsOpen(true)}><ScrollText size={13} /> Live log</button><button className="main-settings-button" onClick={() => setSettingsOpen(true)}><SettingsIcon /> Settings</button></>}</div></header>
      {mainPage ? <section className="welcome-page">
        <div className="welcome-copy">
          <span className="eyebrow">PRIVATE DESKTOP VOICE LAYER</span>
          <h1>Speak naturally.<br /><em>Work precisely.</em></h1>
          <p>Tawny listens for your shortcut, understands what you mean, and returns the result to the app already in focus.</p>
          <div className="welcome-actions"><button className="launch-button" onClick={() => { setMainPage(false); void window.voiceRouter?.enterBackground(); }}>Run in background <KeyboardIcon /></button><button className="secondary-button" onClick={() => setSettingsOpen(true)}><SettingsIcon /> Configure providers</button></div>
        </div>
        <div className="welcome-preview">
          <div className="preview-orbit orbit-one" /><div className="preview-orbit orbit-two" />
          <div className="preview-card"><img src="/tawny-mark.svg" alt="" /><strong>Ready when you are</strong><span>Ctrl + Alt + Space</span></div>
        </div>
      </section> : <section className="overlay-body">
        <div className="state-rail"><span className="state-index">{state === 'idle' ? 'READY' : state.toUpperCase()}</span></div>
        <div className={`control-card ${state === 'confirming' ? 'confirm-card' : ''} ${state === 'failed' ? 'error-card' : ''}`}>
          <div className="control-visual">
            {isListening ? <><button className="round-button danger" onClick={() => window.voiceRouter?.send('CANCEL')} aria-label="Cancel"><X size={14} /></button><Waveform rms={snapshot.rms} /><button className="round-button confirm" onClick={() => window.voiceRouter?.send('STOP')} aria-label="Finish recording"><Check size={15} /></button></> : isBusy ? <LoaderCircle className="spinner" size={28} /> : state === 'done' ? <div className="done-ring"><Check size={17} /></div> : <div className="mic-glyph"><Mic size={18} /></div>}
          </div>
          <div className="control-copy"><strong>{label[0]}</strong><span>{label[1]}</span></div>
          {snapshot.imageDataUrl && state === 'done' && <img className="result-image" src={snapshot.imageDataUrl} alt="Generated result" />}
          {state === 'confirming' && <button className="confirm-action" onClick={() => window.voiceRouter?.send('CONFIRM')}>Confirm <kbd>Enter</kbd></button>}
        </div>
        <p className="hint"><KeyboardIcon /> <span><kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>Space</kbd> toggle</span><span className="hint-divider" /><ShieldCheck size={13} /> <span>Private by default</span></p>
      </section>}
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
