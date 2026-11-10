import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Activity, AudioLines, Check, Copy, FolderOpen, House, LoaderCircle, Lock, LogOut, Minus, RotateCw, Settings2, Trash2, X } from 'lucide-react';
import type { AuthProfile, BehaviorSettings, HandsFreeStatus, Intent, JobHistoryEntry, PipelineLog, RecoveryRecording, RecoveryState } from '../shared/contracts';

/**
 * The app window: a rail with four pages (Home, Recordings, Activity,
 * Settings). Purely presentational; every action goes through the same
 * window.voiceRouter calls the old single page used. The overlay pill is
 * rendered elsewhere and is not part of this file.
 */

export type Page = 'home' | 'recordings' | 'activity' | 'settings';

const PAGE_TITLES: Record<Page, string> = { home: 'Home', recordings: 'Recordings', activity: 'Activity', settings: 'Settings' };

const INTENT_LABEL: Record<Intent, string> = {
  plain_dictation: 'Dictate',
  text_rewrite: 'Rewrite',
  text_query: 'Create',
  image_generate: 'Image',
  computer_control: 'Control'
};

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return clock(iso);
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(iso)}`;
}

export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export function waitingCount(state: RecoveryState | undefined): number {
  return state?.recordings.filter((item) => item.hasAudio).length ?? 0;
}

/** Five orange bars; they move while Tawny is listening and rest when it is not. */
function LevelGlyph({ live }: { live: boolean }): ReactElement {
  return <span className={`level-glyph ${live ? 'is-live' : ''}`} aria-hidden="true"><i /><i /><i /><i /><i /></span>;
}

function Counter({ value, tone }: { value: number; tone?: 'accent' | 'muted' }): ReactElement {
  return <span className={`tape-counter ${tone ? `is-${tone}` : ''}`}>{String(value).padStart(2, '0')}</span>;
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

export interface ShellProps {
  page: Page;
  onNavigate: (page: Page) => void;
  profile: AuthProfile;
  handsFree: HandsFreeStatus;
  onToggleHandsFree: () => void;
  recovery: RecoveryState | undefined;
  version: string;
  onSignOut: () => void;
  banner?: ReactNode;
  children: ReactNode;
}

export function Shell({ page, onNavigate, profile, handsFree, onToggleHandsFree, recovery, version, onSignOut, banner, children }: ShellProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const waiting = waitingCount(recovery);
  const nav: Array<{ id: Page; label: string; icon: ReactElement; badge?: number }> = [
    { id: 'home', label: 'Home', icon: <House size={15} strokeWidth={1.8} /> },
    { id: 'recordings', label: 'Recordings', icon: <AudioLines size={15} strokeWidth={1.8} />, badge: waiting },
    { id: 'activity', label: 'Activity', icon: <Activity size={15} strokeWidth={1.8} /> },
    { id: 'settings', label: 'Settings', icon: <Settings2 size={15} strokeWidth={1.8} /> }
  ];
  const listening = handsFree.state === 'listening';
  const handsFreeLabel = listening ? 'Listening' : handsFree.state === 'off' ? 'Hands-free off' : handsFree.state === 'error' ? 'Needs attention' : handsFree.state === 'paused' ? 'Paused' : 'Starting';
  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-brand">
          <img src="./tawny-mark.svg" alt="" />
          <span>Tawny</span>
        </div>
        <nav className="rail-nav" aria-label="Sections">
          {nav.map((item) => (
            <button key={item.id} className={`rail-link ${page === item.id ? 'is-active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
              {item.icon}
              <span>{item.label}</span>
              {item.badge ? <span className="rail-badge">{item.badge}</span> : null}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <button className={`rail-live ${listening ? 'is-on' : ''} ${handsFree.state === 'error' ? 'is-error' : ''}`} onClick={onToggleHandsFree} title={handsFree.message}>
            <LevelGlyph live={listening} />
            <span><strong>{handsFreeLabel}</strong><small>{handsFree.enabled ? '“Hey Tawny”' : 'Click to turn on'}</small></span>
          </button>
          <div className="rail-account">
            <button className="rail-avatar" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} title={profile.email}>
              <span className="avatar-letter">{profile.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="rail-account-copy"><strong>{profile.displayName.split(' ')[0]}</strong><small>{profile.email}</small></span>
            </button>
            {menuOpen && <div className="rail-menu" role="menu">
              <button role="menuitem" onClick={() => { setMenuOpen(false); onSignOut(); }}><LogOut size={13} /> Sign out</button>
            </div>}
          </div>
          <span className="rail-version">v{version}</span>
        </div>
      </aside>
      <section className="stage">
        <header className="titlebar">
          <h1>{PAGE_TITLES[page]}</h1>
          <div className="window-controls">
            <button aria-label="Minimize" onClick={() => void window.voiceRouter?.windowAction('minimize')}><Minus size={14} /></button>
            <button aria-label="Close to tray" title="Tawny keeps running in the tray" onClick={() => void window.voiceRouter?.windowAction('hide')}><X size={14} /></button>
          </div>
        </header>
        {banner}
        <div className="stage-body" key={page}>{children}</div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export interface HomeProps {
  profile: AuthProfile;
  shortcut: string;
  shortcutRegistered: boolean;
  behavior: BehaviorSettings;
  handsFree: HandsFreeStatus;
  history: JobHistoryEntry[];
  recovery: RecoveryState | undefined;
  onBehavior: (patch: Partial<BehaviorSettings>) => void;
  onNavigate: (page: Page) => void;
  onBackground: () => void;
}

const EXAMPLES: Array<{ n: string; title: string; lines: string[] }> = [
  { n: '01', title: 'Dictate', lines: ['Just talk.', 'Text lands at your cursor.'] },
  { n: '02', title: 'Rewrite', lines: ['Select text, then', '“make this formal”'] },
  { n: '03', title: 'Create', lines: ['“write a short poem…”', '“image of a fox at dusk”'] },
  { n: '04', title: 'Control', lines: ['“open WhatsApp”', '“open D drive”'] }
];

export function HomePage({ profile, shortcut, shortcutRegistered, behavior, handsFree, history, recovery, onBehavior, onNavigate, onBackground }: HomeProps): ReactElement {
  const today = new Date().toDateString();
  const todays = history.filter((entry) => new Date(entry.at).toDateString() === today);
  const done = todays.filter((entry) => entry.outcome === 'done').length;
  const failed = todays.filter((entry) => entry.outcome === 'failed').length;
  const waiting = waitingCount(recovery);
  const listening = handsFree.state === 'listening';
  return (
    <div className="home">
      <div className="home-head">
        <div>
          <p className="kicker">{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h2 className="display">{greeting()}, {profile.displayName.split(' ')[0]}.</h2>
        </div>
        <button className="btn btn-primary" onClick={onBackground}>Run in background</button>
      </div>

      <div className="home-grid">
        <section className="card status-card">
          <p className="kicker">Status</p>
          <div className="status-main">
            <LevelGlyph live={listening} />
            <div>
              <strong className="status-big">{listening ? <>Listening for <em>“Hey Tawny”</em></> : behavior.handsFree ? handsFree.state === 'error' ? 'Hands-free needs attention' : 'Starting the listener…' : 'Shortcut only'}</strong>
              <small className={handsFree.state === 'error' ? 'is-error' : ''}>{handsFree.message}</small>
            </div>
          </div>
          <div className="status-row">
            <span className="kicker">Shortcut</span>
            <kbd className="kbd">{shortcut.split('+').join(' + ')}</kbd>
            {!shortcutRegistered && <button className="link" onClick={() => onNavigate('settings')}>Check it</button>}
          </div>
          <div className="switches">
            <Switch label="Hands-free" checked={behavior.handsFree} onChange={(value) => onBehavior({ handsFree: value })} />
            <Switch label="Show cursor" checked={behavior.controlStyle === 'visual'} onChange={(value) => onBehavior({ controlStyle: value ? 'visual' : 'fast' })} />
          </div>
        </section>

        <section className="card today-card">
          <p className="kicker">Today</p>
          <div className="tally">
            <div><Counter value={done} /><span>done</span></div>
            <div><Counter value={failed} tone={failed ? 'accent' : 'muted'} /><span>failed</span></div>
          </div>
          <button className={`today-link ${waiting ? 'has-items' : ''}`} onClick={() => onNavigate('recordings')}>
            <Counter value={waiting} tone={waiting ? 'accent' : 'muted'} />
            <span>{waiting === 1 ? 'recording to transcribe again' : 'recordings to transcribe again'}</span>
            <span className="arrow">→</span>
          </button>
        </section>
      </div>

      <section className="section">
        <div className="rule-head"><span className="kicker">What to say</span></div>
        <div className="examples">
          {EXAMPLES.map((example) => (
            <div className="example" key={example.n}>
              <span className="example-n">{example.n}</span>
              <strong>{example.title}</strong>
              {example.lines.map((line) => <span key={line}>{line}</span>)}
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="rule-head"><span className="kicker">Recent</span>{history.length > 0 && <button className="link" onClick={() => onNavigate('activity')}>Full activity</button>}</div>
        {history.length === 0
          ? <p className="empty">Nothing yet. Press {shortcut.split('+').join(' + ')} or say “Hey Tawny”.</p>
          : <ul className="ledger">
            {history.slice(0, 5).map((entry) => (
              <li key={entry.jobId} className={`ledger-row is-${entry.outcome}`}>
                <time>{dayLabel(entry.at)}</time>
                <span className="tag">{entry.intent ? INTENT_LABEL[entry.intent] : entry.source === 'wake' ? 'Hands-free' : 'Shortcut'}</span>
                <span className="ledger-msg" title={entry.message}>{entry.message}</span>
                {entry.savedRecording
                  ? <button className="chip chip-accent" onClick={() => onNavigate('recordings')}>Saved</button>
                  : <span className={`chip ${entry.outcome === 'done' ? 'chip-ok' : 'chip-bad'}`}>{entry.outcome}</span>}
              </li>
            ))}
          </ul>}
      </section>
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): ReactElement {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span /></span>
      <span>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

const STATUS_CHIP: Record<RecoveryRecording['status'], [string, string]> = {
  pending: ['Saved', 'chip'],
  working: ['Sending', 'chip chip-accent'],
  waiting: ['Waiting', 'chip chip-warn'],
  failed: ['Retry failed', 'chip chip-bad'],
  transcribed: ['Text ready', 'chip chip-ok']
};

export function RecordingsPage({ state }: { state: RecoveryState | undefined }): ReactElement {
  const [copied, setCopied] = useState<string | undefined>(undefined);
  const [error, setError] = useState('');
  const recordings = state?.recordings ?? [];
  const retryable = recordings.filter((item) => item.hasAudio && item.status !== 'working').length;
  const budget = state?.budget;

  async function run(action: () => Promise<void> | undefined): Promise<void> {
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'That did not work.');
    }
  }

  async function copy(id: string): Promise<void> {
    await run(() => window.voiceRouter?.copyRecording(id));
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? undefined : current)), 1600);
  }

  return (
    <div className="recordings">
      <div className="page-head">
        <p className="lede"><Lock size={12} /> When a request fails, its recording is kept here, encrypted on this PC. You can't play it back. It deletes itself after 7 days, or once its text is ready.</p>
        <div className="page-actions">
          {recordings.length > 0 && <button className="btn btn-quiet" onClick={() => void run(() => window.voiceRouter?.clearRecordings())}>Clear all</button>}
          <button className="btn btn-primary" disabled={retryable === 0} onClick={() => void run(() => window.voiceRouter?.retryRecording())}><RotateCw size={13} /> Transcribe all{retryable ? ` (${retryable})` : ''}</button>
        </div>
      </div>
      {budget && <div className="budget" title="Groq free tier limits for Whisper. Tawny paces retries to stay inside them and leaves room for live requests.">
        <span className="kicker">Groq budget</span>
        <Meter label="req / min" used={budget.requestsLastMinute} limit={budget.limits.requestsPerMinute} />
        <Meter label="audio / hour" used={budget.audioSecondsLastHour} limit={budget.limits.audioSecondsPerHour} format={duration} />
        <Meter label="audio / day" used={budget.audioSecondsToday} limit={budget.limits.audioSecondsPerDay} format={duration} />
      </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {state && !state.available
        ? <p className="empty">Secure storage isn't available on this device, so Tawny can't keep failed recordings.</p>
        : recordings.length === 0
          ? <div className="empty-block"><AudioLines size={22} strokeWidth={1.5} /><p>Nothing to recover.</p><small>If the network drops or Groq is busy while you speak, the recording waits here so nothing you said is lost.</small></div>
          : <ul className="tape-list">
            {recordings.map((item) => {
              const [chipLabel, chipClass] = STATUS_CHIP[item.status];
              return (
                <li key={item.id} className="tape">
                  <div className="tape-meta">
                    <time>{dayLabel(item.createdAt)}</time>
                    <span>{item.source === 'wake' ? 'Hands-free' : 'Shortcut'}</span>
                    <span>{duration(item.durationMs)}</span>
                    {item.hasAudio && <span>{size(item.bytes)}</span>}
                    <span className={chipClass}>{item.status === 'working' && <LoaderCircle size={10} className="spin" />}{chipLabel}</span>
                  </div>
                  <div className="tape-body">
                    {item.transcript
                      ? <p className="tape-text">“{item.transcript}”</p>
                      : <p className="tape-reason">{item.lastError ?? item.reason}</p>}
                    <div className="tape-actions">
                      {item.transcript
                        ? <button className="btn btn-small" onClick={() => void copy(item.id)}>{copied === item.id ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}</button>
                        : <button className="btn btn-small btn-ink" disabled={item.status === 'working'} onClick={() => void run(() => window.voiceRouter?.retryRecording(item.id))}><RotateCw size={12} /> {item.attempts ? 'Try again' : 'Transcribe again'}</button>}
                      <button className="icon-btn" aria-label="Delete recording" onClick={() => void run(() => window.voiceRouter?.removeRecording(item.id))}><Trash2 size={13} /></button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>}
    </div>
  );
}

function Meter({ label, used, limit, format = String }: { label: string; used: number; limit: number; format?: (value: number) => string }): ReactElement {
  const ratio = Math.min(1, limit ? used / limit : 0);
  const show = format === String ? format : (value: number) => format(value * 1000);
  return (
    <span className={`meter ${ratio > 0.8 ? 'is-high' : ''}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar"><i style={{ width: `${Math.max(2, ratio * 100)}%` }} /></span>
      <span className="meter-value">{show(used)}<em>/{show(limit)}</em></span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function ActivityPage({ logs, shortcut }: { logs: PipelineLog[]; shortcut: string }): ReactElement {
  const [filter, setFilter] = useState<'all' | 'warn' | 'error'>('all');
  const shown = useMemo(() => {
    const items = filter === 'all' ? logs : logs.filter((entry) => (filter === 'error' ? entry.level === 'error' : entry.level === 'warn' || entry.level === 'error'));
    return [...items].reverse();
  }, [logs, filter]);
  const counts = { warn: logs.filter((entry) => entry.level === 'warn' || entry.level === 'error').length, error: logs.filter((entry) => entry.level === 'error').length };
  return (
    <div className="activity">
      <div className="page-head">
        <div className="filters" role="tablist">
          {(['all', 'warn', 'error'] as const).map((id) => (
            <button key={id} role="tab" aria-selected={filter === id} className={`filter ${filter === id ? 'is-active' : ''}`} onClick={() => setFilter(id)}>
              {id === 'all' ? 'All' : id === 'warn' ? 'Warnings' : 'Errors'}
              {id !== 'all' && counts[id] > 0 && <span className="filter-count">{counts[id]}</span>}
            </button>
          ))}
        </div>
        <button className="btn btn-quiet" onClick={() => void window.voiceRouter?.openLogsFolder()}><FolderOpen size={13} /> Open logs folder</button>
      </div>
      <p className="lede">Every step of every request, newest first. Keys and what you said are never written here.</p>
      <div className="log-scroll">
        {shown.length === 0
          ? <p className="empty">{logs.length === 0 ? `No activity yet. Press ${shortcut.split('+').join(' + ')} to start.` : 'Nothing matches this filter.'}</p>
          : shown.map((entry, index) => (
            <div className={`log-line lv-${entry.level}`} key={`${entry.timestamp}-${index}`}>
              <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
              <span className="log-ev">{entry.event}</span>
              <span className="log-msg">{entry.message}</span>
              {entry.durationMs !== undefined && <span className="log-ms">{entry.durationMs} ms</span>}
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings frame (the controls themselves stay in main.tsx, unchanged)
// ---------------------------------------------------------------------------

export function SettingsSection({ id, title, hint, aside, children }: { id: string; title: string; hint: string; aside?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section className="set-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="set-head">
        <div><h3 id={`${id}-title`}>{title}</h3><p>{hint}</p></div>
        {aside}
      </div>
      <div className="set-body">{children}</div>
    </section>
  );
}
