import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '.') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'dpapi'),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString())
  },
  shell: { openExternal: vi.fn() }
}));

import { readResponse } from '../src/main/auth';

describe('OAuth response handling', () => {
  it('explains Google invalid_grant errors instead of hiding them as Firebase failures', async () => {
    const response = new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }), { status: 400 });

    await expect(readResponse(response, 'Google'))
      .rejects.toThrow(/Google rejected the authorization code \(invalid_grant\)/);
  });

  it('preserves Google invalid_request details needed to diagnose token exchange failures', async () => {
    const response = new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Missing required parameter: code_verifier' }), { status: 400 });

    await expect(readResponse(response, 'Google'))
      .rejects.toThrow(/invalid_request\): Missing required parameter: code_verifier/);
  });

  it('retains a safe provider error code for diagnostics without exposing response details', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'INVALID_IDP_RESPONSE : internal details' } }), { status: 400 });

    await expect(readResponse(response, 'Firebase Authentication'))
      .rejects.toThrow(/Firebase Authentication could not complete sign-in \(INVALID_IDP_RESPONSE\)/);
  });

  it('maps disabled Firebase Google sign-in to a direct setup instruction', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'OPERATION_NOT_ALLOWED' } }), { status: 400 });

    await expect(readResponse(response, 'Firebase Authentication'))
      .rejects.toThrow(/Google sign-in is not enabled/);
  });
});
