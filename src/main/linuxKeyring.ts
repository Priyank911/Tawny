export function linuxPasswordStorePreference(
  platform: NodeJS.Platform,
  hasExplicitPasswordStore: boolean,
  desktopEnvironment: string | undefined
): string | undefined {
  if (platform !== 'linux' || hasExplicitPasswordStore) return undefined;

  const desktops = (desktopEnvironment ?? '').toLowerCase().split(/[:;]/);
  // Keep Electron's native KWallet detection on KDE so existing wallet data
  // continues to be available. For other desktops/window managers (including
  // Hyprland), use Secret Service through libsecret instead of basic_text.
  if (desktops.some((desktop) => desktop.includes('kde'))) return undefined;
  return 'gnome-libsecret';
}
