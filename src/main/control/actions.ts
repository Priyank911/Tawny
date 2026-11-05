import { z } from 'zod';

/**
 * The closed set of things Tawny may do to the computer. Both the local
 * grammar and the LLM planner can only produce these verbs, every plan is
 * validated against this schema, and nothing here can run a shell command.
 */
export const MAX_PLAN_STEPS = 8;

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

export const actionSchema = z.discriminatedUnion('verb', [
  // Resolve a spoken name (folder, drive, app, file, website) and open it.
  z.object({
    verb: z.literal('open'),
    target: nonEmpty(160),
    drive: z.string().regex(/^[A-Za-z]$/).optional(),
    hint: z.enum(['folder', 'app', 'site', 'drive', 'file', 'any']).optional()
  }),
  z.object({ verb: z.literal('open_path'), path: nonEmpty(520) }),
  z.object({ verb: z.literal('launch_app'), name: nonEmpty(80) }),
  z.object({ verb: z.literal('open_url'), url: nonEmpty(2000) }),
  z.object({ verb: z.literal('focus_window'), query: nonEmpty(120) }),
  z.object({
    verb: z.literal('ui_click'),
    query: nonEmpty(120),
    double: z.boolean().optional(),
    button: z.enum(['left', 'right']).optional()
  }),
  z.object({ verb: z.literal('type'), text: nonEmpty(500) }),
  z.object({ verb: z.literal('key'), combo: nonEmpty(40) }),
  z.object({
    verb: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.enum(['small', 'page', 'top', 'bottom'])
  }),
  z.object({ verb: z.literal('window'), op: z.enum(['minimize', 'maximize', 'restore', 'close']) }),
  z.object({ verb: z.literal('wait'), ms: z.number().int().min(50).max(2000) })
]);
export type Action = z.infer<typeof actionSchema>;

export const planSchema = z.object({
  steps: z.array(actionSchema).min(1).max(MAX_PLAN_STEPS),
  summary: z.string().max(140).optional()
});
export type Plan = z.infer<typeof planSchema>;

export type PlanOrigin = 'grammar' | 'planner';

/** Programs a voice command must never start or type into: they turn "type" plus "enter" into arbitrary code execution. */
const SHELL_PROCESSES = new Set([
  'cmd', 'powershell', 'powershell_ise', 'pwsh', 'wt', 'windowsterminal', 'conhost', 'openconsole',
  'bash', 'wsl', 'wslhost', 'sh', 'mintty', 'cscript', 'wscript', 'mshta', 'regedit', 'regedt32',
  'mmc', 'gpedit', 'secpol', 'runas', 'psexec', 'node', 'python', 'pythonw', 'py', 'ruby', 'perl'
]);

const BLOCKED_APP_WORDS = /\b(?:command prompt|cmd|powershell|windows terminal|terminal|console|registry editor|regedit|group policy|task scheduler|wsl|bash|shell)\b/i;

export function executableName(pathOrName: string): string {
  const base = pathOrName.replace(/^.*[\\/]/, '').toLowerCase();
  return base.replace(/\.(?:exe|com|bat|cmd|lnk)$/i, '');
}

export function isShellProcess(pathOrName: string): boolean {
  return SHELL_PROCESSES.has(executableName(pathOrName));
}

export function isBlockedAppName(name: string): boolean {
  return BLOCKED_APP_WORDS.test(name) || isShellProcess(name);
}

const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'com', 'bat', 'cmd', 'scr', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'reg', 'jar', 'dll', 'cpl', 'msc', 'lnk', 'appx', 'msix', 'pif', 'gadget', 'inf', 'scf', 'url'
]);

export function fileExtension(path: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(path.trim());
  return match ? match[1].toLowerCase() : '';
}

export function isExecutablePath(path: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(fileExtension(path));
}

const DESTRUCTIVE_WORDS = /\b(?:delete|remove|erase|wipe|format|uninstall|send|submit|pay|purchase|buy|checkout|place order|post|publish|transfer|sign out|log out|logout|reset|empty|clear|discard|overwrite|install|allow|grant|accept|agree|yes|confirm|ok|close|quit|exit|shutdown|shut down|restart|reboot)\b/i;

export function isDestructiveLabel(label: string): boolean {
  return DESTRUCTIVE_WORDS.test(label);
}

const BLOCKED_KEYS = new Set(['win+r', 'win+x', 'win+l', 'ctrl+alt+delete', 'ctrl+alt+del', 'ctrl+shift+escape']);
const CONFIRM_KEYS = new Set([
  'delete', 'del', 'shift+delete', 'shift+del', 'alt+f4', 'ctrl+w', 'ctrl+f4', 'ctrl+shift+w', 'ctrl+q',
  'ctrl+shift+delete', 'ctrl+shift+del'
]);

export function normalizeCombo(combo: string): string {
  return combo
    .toLowerCase()
    .replace(/\bcontrol\b/g, 'ctrl')
    .replace(/\bescape\b/g, 'esc')
    .replace(/\breturn\b/g, 'enter')
    .replace(/\s*\+\s*/g, '+')
    .replace(/\s+/g, '+')
    .replace(/^\++|\++$/g, '');
}

export type Risk = { level: 'safe' } | { level: 'confirm'; reason: string } | { level: 'blocked'; reason: string };

export function assessAction(action: Action, origin: PlanOrigin, previous?: Action): Risk {
  switch (action.verb) {
    case 'open': {
      if (isBlockedAppName(action.target)) return { level: 'blocked', reason: 'Tawny does not start command shells or system editors by voice.' };
      return { level: 'safe' };
    }
    case 'open_path':
      if (isExecutablePath(action.path)) return { level: 'blocked', reason: 'Tawny will not run programs or scripts by path.' };
      return { level: 'safe' };
    case 'launch_app':
      return isBlockedAppName(action.name)
        ? { level: 'blocked', reason: 'Tawny does not start command shells or system editors by voice.' }
        : { level: 'safe' };
    case 'open_url': {
      let url: URL;
      try {
        url = new URL(action.url);
      } catch {
        return { level: 'blocked', reason: 'That is not a valid web address.' };
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { level: 'blocked', reason: 'Only web addresses can be opened by voice.' };
      if (url.username || url.password) return { level: 'blocked', reason: 'Addresses with embedded credentials are not opened.' };
      return origin === 'planner'
        ? { level: 'confirm', reason: `Open ${url.hostname}?` }
        : { level: 'safe' };
    }
    case 'window':
      return action.op === 'close'
        ? { level: 'confirm', reason: 'Close the current window?' }
        : { level: 'safe' };
    case 'focus_window':
    case 'scroll':
    case 'wait':
      return { level: 'safe' };
    case 'ui_click':
      return isDestructiveLabel(action.query)
        ? { level: 'confirm', reason: `Click "${action.query}"?` }
        : { level: 'safe' };
    case 'type':
      return { level: 'safe' };
    case 'key': {
      const combo = normalizeCombo(action.combo);
      if (BLOCKED_KEYS.has(combo)) return { level: 'blocked', reason: `${combo} is not available by voice.` };
      if (CONFIRM_KEYS.has(combo)) return { level: 'confirm', reason: `Press ${combo}?` };
      if ((combo === 'enter' || combo === 'ctrl+enter') && previous?.verb === 'type') {
        return { level: 'confirm', reason: 'Submit what was just typed?' };
      }
      return { level: 'safe' };
    }
  }
}

export interface PlanAssessment {
  blocked?: string;
  confirm?: string;
}

export function assessPlan(plan: Plan, origin: PlanOrigin): PlanAssessment {
  let confirm: string | undefined;
  for (const [index, step] of plan.steps.entries()) {
    const risk = assessAction(step, origin, plan.steps[index - 1]);
    if (risk.level === 'blocked') return { blocked: risk.reason };
    if (risk.level === 'confirm' && !confirm) confirm = risk.reason;
  }
  return confirm ? { confirm } : {};
}

/** Short spoken-style description of a step for the overlay. */
export function describeAction(action: Action): string {
  switch (action.verb) {
    case 'open': return `Opening ${action.target}${action.drive ? ` on ${action.drive.toUpperCase()}:` : ''}`;
    case 'open_path': return 'Opening folder';
    case 'launch_app': return `Starting ${action.name}`;
    case 'open_url': return 'Opening website';
    case 'focus_window': return `Switching to ${action.query}`;
    case 'ui_click': return `${action.double ? 'Double-clicking' : 'Clicking'} ${action.query}`;
    case 'type': return 'Typing';
    case 'key': return `Pressing ${action.combo}`;
    case 'scroll': return `Scrolling ${action.direction}`;
    case 'window': return `${action.op[0].toUpperCase()}${action.op.slice(1)} window`;
    case 'wait': return 'Waiting';
  }
}
