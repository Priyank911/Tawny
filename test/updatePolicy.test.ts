import { describe, expect, it } from 'vitest';
import { RETRY_AFTER_FAILURE_MS, blockedMessage, isPolicyBlock, shouldAutoInstall } from '../src/main/updatePolicy';

describe('update install policy', () => {
  it('recognises the spawn errors Smart App Control produces', () => {
    expect(isPolicyBlock('UNKNOWN')).toBe(true);
    expect(isPolicyBlock('EACCES')).toBe(true);
    expect(isPolicyBlock('EPERM')).toBe(true);
    expect(isPolicyBlock('ENOENT')).toBe(false);
    expect(isPolicyBlock(undefined)).toBe(false);
  });

  it('does not close Tawny again for a version that just failed to install', () => {
    const now = 1_000_000_000;
    expect(shouldAutoInstall(undefined, '0.1.16', now)).toBe(true);
    expect(shouldAutoInstall({ version: '0.1.15', at: now }, '0.1.15', now + 60_000)).toBe(false);
    expect(shouldAutoInstall({ version: '0.1.15', at: now }, '0.1.15', now + RETRY_AFTER_FAILURE_MS + 1)).toBe(true);
    expect(shouldAutoInstall({ version: '0.1.15', at: now }, '0.1.16', now + 60_000)).toBe(true);
  });

  it('explains the block and the way out', () => {
    const message = blockedMessage('0.1.15', '0.1.14');
    expect(message).toMatch(/^Windows blocked/);
    expect(message).toContain('still on 0.1.14');
    expect(message).toContain('release page');
  });
});
