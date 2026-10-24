export const DEFAULT_GLOBAL_SHORTCUT = 'Ctrl+Alt+Space';

const modifierAliases: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  command: 'Command',
  cmd: 'Command',
  meta: process.platform === 'darwin' ? 'Command' : 'Super',
  super: 'Super'
};

const keyAliases: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Return',
  return: 'Return',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right'
};

export function normalizeGlobalShortcut(input: string): string | undefined {
  const pieces = input.split('+').map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length < 2) return undefined;
  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const piece of pieces) {
    const modifier = modifierAliases[piece.toLowerCase()];
    if (modifier) {
      if (modifiers.includes(modifier)) return undefined;
      modifiers.push(modifier);
      continue;
    }
    const alias = keyAliases[piece.toLowerCase()];
    const key = alias ?? (/^[a-z0-9]$/i.test(piece) ? piece.toUpperCase() : /^F([1-9]|1[0-9]|2[0-4])$/i.test(piece) ? piece.toUpperCase() : undefined);
    if (!key || keys.length > 0) return undefined;
    keys.push(key);
  }
  if (modifiers.length === 0 || keys.length !== 1) return undefined;
  const order = ['Ctrl', 'Alt', 'Shift', 'Command', 'Super'];
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...modifiers, keys[0]].join('+');
}

export function isWaylandSession(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === 'linux' && Boolean(env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland');
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCompositorTriggerCommand(executable: string, appPath?: string): string {
  const args = appPath ? ` ${quotePosix(appPath)}` : '';
  return `${quotePosix(executable)}${args} --trigger`;
}
