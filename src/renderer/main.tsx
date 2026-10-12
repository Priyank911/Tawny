import { StrictMode, useEffect, useMemo, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, Keyboard, LoaderCircle, Mic, Settings2, ShieldCheck, X } from 'lucide-react';
import type { OverlaySnapshot, ProviderSettings } from '../shared/contracts';
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
    groqApiKey: '', geminiApiKey: '', cloudflareAccountId: '', cloudflareApiToken: ''
  });
  const [saved, setSaved] = useState(false);
  const [mainPage, setMainPage] = useState(true);
  useEffect(() => {
    if (!window.voiceRouter) return undefined;
    void window.voiceRouter.getSnapshot().then(setSnapshot);
    void window.voiceRouter.getSettings().then(setSettings);
    const unsubscribeSnapshot = window.voiceRouter.subscribe(setSnapshot);
    const unsubscribeSettings = window.voiceRouter.onOpenSettings(() => setSettingsOpen(true));
    const unsubscribeBackground = window.voiceRouter.onBackgroundMode(() => setMainPage(false));
    return () => {
      unsubscribeSnapshot();
      unsubscribeSettings();
      unsubscribeBackground();
    };
  }, []);
  const state = snapshot.state;
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
    done: ['Done', 'Image pasted successfully'],
    failed: ['Something went wrong', snapshot.message ?? 'Retry from the tray'],
    cancelled: ['Cancelled', 'Nothing was sent']
  } as Record<string, [string, string]>)[state] ?? ['Tawny', ''], []);

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
      <header className="topbar"><div className="brand"><img className="brand-mark" src="/tawny-mark.svg" alt="" /><span>Tawny</span></div><div className="top-actions"><span className="status-dot" /><span className="status-label">READY</span>{mainPage && <button className="main-settings-button" onClick={() => setSettingsOpen(true)}><SettingsIcon /> Settings</button>}</div></header>
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
            {isListening ? <><button className="round-button danger" onClick={() => window.voiceRouter?.send('CANCEL')} aria-label="Cancel"><X size={16} /></button><Waveform rms={snapshot.rms} /><button className="round-button confirm" onClick={() => window.voiceRouter?.send('STOP')} aria-label="Finish recording"><Check size={17} /></button></> : isBusy ? <LoaderCircle className="spinner" size={42} /> : state === 'done' ? <div className="done-ring"><Check size={20} /></div> : <div className="mic-glyph"><Mic size={21} /></div>}
          </div>
          <div className="control-copy"><strong>{label[0]}</strong><span>{label[1]}</span></div>
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
              ['geminiApiKey', 'Gemini API key', 'Used for image generation'],
              ['cloudflareAccountId', 'Cloudflare account ID', 'Workers AI account identifier'],
              ['cloudflareApiToken', 'Cloudflare API token', 'Scoped Workers AI token']
            ] as const).map(([key, title, hint]) => <label className="field" key={key}><span>{title}</span><small>{hint}</small><input type={key.toLowerCase().includes('key') || key.toLowerCase().includes('token') ? 'password' : 'text'} value={settings[key]} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} placeholder="Not connected" autoComplete="off" /></label>)}
          </div>
          <div className="settings-footer"><span className={saved ? 'saved' : ''}>{saved ? 'Saved securely' : 'Credentials stay on this device.'}</span><button className="save-button" onClick={() => void saveSettings()}>Save credentials</button></div>
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
