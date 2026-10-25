export function shouldDispatchShortcutTrigger(state: {
  settingsOpen: boolean;
  captureMode: boolean;
  testPending: boolean;
}): boolean {
  // A test is intentionally allowed while Settings is open. Real triggers
  // must not collapse/reopen the overlay while the user is editing shortcuts.
  return state.testPending || (!state.settingsOpen && !state.captureMode);
}
