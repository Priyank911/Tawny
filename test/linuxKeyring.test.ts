import { describe, expect, it } from 'vitest';
import { linuxPasswordStorePreference } from '../src/main/linuxKeyring';

describe('Linux secure-storage backend preference', () => {
  it('uses libsecret on unrecognized desktops such as Hyprland', () => {
    expect(linuxPasswordStorePreference('linux', false, 'Hyprland')).toBe('gnome-libsecret');
  });

  it('uses libsecret when the desktop environment is unset', () => {
    expect(linuxPasswordStorePreference('linux', false, undefined)).toBe('gnome-libsecret');
  });

  it('preserves Electron KWallet detection on KDE', () => {
    expect(linuxPasswordStorePreference('linux', false, 'KDE:Plasma')).toBeUndefined();
  });

  it('respects an explicitly supplied password-store switch', () => {
    expect(linuxPasswordStorePreference('linux', true, 'Hyprland')).toBeUndefined();
  });

  it('does not affect other operating systems', () => {
    expect(linuxPasswordStorePreference('win32', false, undefined)).toBeUndefined();
    expect(linuxPasswordStorePreference('darwin', false, undefined)).toBeUndefined();
  });
});
