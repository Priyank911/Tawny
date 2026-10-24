import { describe, expect, it } from 'vitest';
import { buildCompositorTriggerCommand, isWaylandSession, normalizeGlobalShortcut } from '../src/main/hotkeyConfig';

describe('global shortcut preferences', () => {
  it('normalizes modifier aliases and key case', () => {
    expect(normalizeGlobalShortcut('control + alt + space')).toBe('Ctrl+Alt+Space');
    expect(normalizeGlobalShortcut('shift+f5')).toBe('Shift+F5');
  });

  it('rejects incomplete, duplicate, and unsupported shortcuts', () => {
    expect(normalizeGlobalShortcut('Ctrl')).toBeUndefined();
    expect(normalizeGlobalShortcut('Ctrl+Ctrl+K')).toBeUndefined();
    expect(normalizeGlobalShortcut('Ctrl+NotAKey')).toBeUndefined();
  });

  it('detects Wayland only on Linux', () => {
    expect(isWaylandSession('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
    expect(isWaylandSession('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe(true);
    expect(isWaylandSession('linux', { XDG_SESSION_TYPE: 'x11' })).toBe(false);
    expect(isWaylandSession('win32', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
  });

  it('quotes compositor command paths safely', () => {
    expect(buildCompositorTriggerCommand('/opt/Tawny App/tawny')).toBe("'/opt/Tawny App/tawny' --trigger");
    expect(buildCompositorTriggerCommand('/tmp/Tawny', '/opt/App Dir')).toBe("'/tmp/Tawny' '/opt/App Dir' --trigger");
  });
});
