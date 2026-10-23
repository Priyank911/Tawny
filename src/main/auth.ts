import { app, safeStorage, shell } from 'electron';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthProfile } from '../shared/contracts';

interface StoredSession extends AuthProfile {
  refreshToken: string;
  idToken: string;
  expiresAt: number;
}

interface AuthConfiguration {
  apiKey: string;
  projectId: string;
  googleClientId: string;
  googleClientSecret: string;
}

declare const __TAWNY_FIREBASE_CONFIG__: AuthConfiguration;

const SESSION_FILE = 'auth-session.bin';
// Google Desktop OAuth loopback redirects use the loopback origin and port,
// without a custom path segment.
const CALLBACK_PATH = '/';
const OAUTH_TIMEOUT_MS = 180_000;
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIREBASE_AUTH_URL = 'https://identitytoolkit.googleapis.com/v1';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

let session: StoredSession | undefined;
let pendingServer: Server | undefined;
let pendingTimer: NodeJS.Timeout | undefined;
let rejectPendingSignIn: ((error: Error) => void) | undefined;
let refreshPromise: Promise<void> | undefined;
let sessionGeneration = 0;
let sessionInvalidatedHandler: (() => void) | undefined;

export function setAuthSessionInvalidatedHandler(handler: () => void): void {
  sessionInvalidatedHandler = handler;
}

function configuration(): AuthConfiguration {
  return typeof __TAWNY_FIREBASE_CONFIG__ === 'undefined'
    ? { apiKey: '', projectId: '', googleClientId: '', googleClientSecret: '' }
    : __TAWNY_FIREBASE_CONFIG__;
}

function configIsReady(): boolean {
  const config = configuration();
  return Boolean(config.apiKey && config.projectId && config.googleClientId && config.googleClientSecret);
}

function sessionPath(): string {
  return join(app.getPath('userData'), SESSION_FILE);
}

function hasSecureStorage(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // Linux's fallback backend is plaintext, which is not acceptable for refresh tokens.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
  return true;
}

async function persistSession(value: StoredSession): Promise<void> {
  if (!hasSecureStorage()) {
    throw new Error(process.platform === 'linux'
      ? 'Secure sign-in storage is unavailable. Install and unlock GNOME Keyring or KDE Wallet, then try again.'
      : 'Secure sign-in storage is unavailable on this device.');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(value));
  await writeFile(sessionPath(), encrypted, { mode: 0o600 });
}

async function clearPersistedSession(): Promise<void> {
  sessionGeneration += 1;
  session = undefined;
  await rm(sessionPath(), { force: true }).catch(() => undefined);
}

function publicProfile(value = session): AuthProfile | undefined {
  if (!value) return undefined;
  return { email: value.email, displayName: value.displayName, ...(value.photoUrl ? { photoUrl: value.photoUrl } : {}) };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The sign-in service returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

export async function readResponse(response: Response, service: string): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => undefined);
  const body = parseJsonObject(payload);
  if (!response.ok) {
    const errorObject = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : undefined;
    // Google OAuth uses { error: "invalid_grant", error_description: "..." },
    // while Firebase Auth uses { error: { message: "..." } }.
    const code = String(typeof body.error === 'string' ? body.error : errorObject?.message ?? '');
    const description = typeof body.error_description === 'string'
      ? body.error_description.replace(/[\r\n\t]/g, ' ').slice(0, 180)
      : '';
    if (service === 'Google' && code === 'invalid_grant') {
      throw new Error('Google rejected the authorization code (invalid_grant). Start a fresh sign-in; the code may have expired, already been used, or the redirect/PKCE values did not match.');
    }
    if (service === 'Google' && code === 'invalid_client') {
      throw new Error('Google rejected the OAuth client (invalid_client). Check that TAWNY_GOOGLE_CLIENT_ID is the active Desktop app client ID for this project.');
    }
    if (service === 'Google' && code === 'unauthorized_client') {
      throw new Error('Google refused this OAuth client (unauthorized_client). Check the OAuth consent screen and client settings.');
    }
    if (service === 'Google' && code === 'invalid_request') {
      throw new Error(`Google rejected the token exchange (invalid_request)${description ? `: ${description}` : ''}. Check the Desktop OAuth client and retry with a fresh sign-in.`);
    }
    if (code.includes('EMAIL_NOT_FOUND') || code.includes('INVALID_REFRESH_TOKEN') || code.includes('TOKEN_EXPIRED')) {
      throw new Error('Your saved sign-in has expired. Sign in with Google again.');
    }
    if (response.status === 400 && code.includes('OPERATION_NOT_ALLOWED')) {
      throw new Error('Google sign-in is not enabled for this Firebase project. Enable the Google provider in Firebase Authentication.');
    }
    if (response.status === 403 || code.includes('API_KEY_INVALID')) {
      throw new Error('Firebase rejected the app configuration. Check the Firebase API key and enabled Authentication API.');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`${service} is temporarily unavailable. Check your connection and try again.`);
    }
    const safeCode = code.match(/^[A-Za-z0-9_-]+/)?.[0];
    throw new Error(safeCode
      ? `${service} could not complete sign-in (${safeCode}). Check the OAuth client and Firebase provider configuration.`
      : `${service} could not complete sign-in. Check the OAuth client and Firebase provider configuration.`);
  }
  return body;
}

function profileFromFirebase(body: Record<string, unknown>, fallback?: Partial<AuthProfile>): AuthProfile {
  const users = Array.isArray(body.users) ? body.users : [];
  const user = users[0] && typeof users[0] === 'object' ? users[0] as Record<string, unknown> : {};
  const email = String(body.email ?? user.email ?? fallback?.email ?? '').trim();
  if (!email) throw new Error('Google did not provide an email address. Allow email access and try again.');
  return {
    email,
    displayName: String(body.displayName ?? user.displayName ?? fallback?.displayName ?? email.split('@')[0]),
    ...(String(body.photoUrl ?? user.photoUrl ?? fallback?.photoUrl ?? '') ? { photoUrl: String(body.photoUrl ?? user.photoUrl ?? fallback?.photoUrl) } : {})
  };
}

function disposePendingServer(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = undefined;
  const server = pendingServer;
  pendingServer = undefined;
  if (server?.listening) server.close();
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function serveCallbackPage(res: import('node:http').ServerResponse, title: string, message: string): void {
  const safeTitle = title.replace(/[<>&"']/g, '');
  const safeMessage = message.replace(/[<>&"']/g, '');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${safeTitle} · Tawny</title><style>body{margin:0;background:#f7f6f2;color:#26302b;font:16px 'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh}.card{padding:32px 36px;background:white;border:1px solid #d8d5ce;border-radius:22px;box-shadow:0 20px 55px #26302b1c;text-align:center;max-width:420px}.mark{color:#718965;font-size:12px;letter-spacing:.15em;font-weight:700}h1{font-size:24px;margin:16px 0 8px}p{color:#64748b;line-height:1.5;margin:0}</style><main class="card"><span class="mark">TAWNY</span><h1>${safeTitle}</h1><p>${safeMessage}</p></main>`);
}

async function exchangeGoogleCode(code: string, verifier: string, redirectUri: string): Promise<string> {
  const config = configuration();
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('Google could not be reached. Check your connection and try signing in again.');
  }
  const tokens = await readResponse(response, 'Google');
  if (typeof tokens.id_token !== 'string' || !tokens.id_token) throw new Error('Google did not return an identity token. Try signing in again.');
  return tokens.id_token;
}

async function exchangeFirebaseCredential(googleIdToken: string, redirectUri: string): Promise<StoredSession> {
  const config = configuration();
  const postBody = new URLSearchParams({ id_token: googleIdToken, providerId: 'google.com' }).toString();
  let response: Response;
  try {
    response = await fetch(`${FIREBASE_AUTH_URL}/accounts:signInWithIdp?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postBody, requestUri: redirectUri, returnSecureToken: true, returnIdpCredential: true }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Firebase could not be reached. Check your connection and try signing in again.');
  }
  const result = await readResponse(response, 'Firebase Authentication');
  if (typeof result.idToken !== 'string' || typeof result.refreshToken !== 'string') {
    throw new Error('Firebase did not return a persistent sign-in session. Check the Google provider configuration.');
  }
  const profile = profileFromFirebase(result);
  const expiresIn = Number(result.expiresIn ?? 3600);
  return {
    ...profile,
    idToken: result.idToken,
    refreshToken: result.refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000
  };
}

export async function startGoogleSignIn(): Promise<AuthProfile> {
  if (!configIsReady()) {
    throw new Error('Firebase sign-in is not configured for this build. Add the Firebase project values and Google OAuth Desktop client ID and secret, then rebuild.');
  }
  if (!hasSecureStorage()) {
    throw new Error(process.platform === 'linux'
      ? 'Secure sign-in storage is unavailable. Install and unlock GNOME Keyring or KDE Wallet, then try again.'
      : 'Secure sign-in storage is unavailable on this device.');
  }
  if (pendingServer) throw new Error('A Google sign-in window is already open. Finish or close that window first.');

  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const server = createServer();
  pendingServer = server;

  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Could not start the secure sign-in callback.'));
        resolve(address.port);
      });
    });
    const redirectUri = `http://127.0.0.1:${port}`;
    const callbackResult = new Promise<string>((resolve, reject) => {
      rejectPendingSignIn = reject;
      pendingTimer = setTimeout(() => reject(new Error('Google sign-in timed out. Reopen sign-in and try again.')), OAUTH_TIMEOUT_MS);
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        if (url.pathname !== CALLBACK_PATH) {
          response.writeHead(404).end('Not found');
          return;
        }
        if (url.searchParams.get('error')) {
          serveCallbackPage(response, 'Sign-in was not completed', 'You can close this tab and return to Tawny.');
          reject(new Error(url.searchParams.get('error_description') || 'Google sign-in was cancelled.'));
          return;
        }
        const returnedState = url.searchParams.get('state') ?? '';
        const code = url.searchParams.get('code') ?? '';
        if (!constantTimeEqual(state, returnedState) || !code) {
          serveCallbackPage(response, 'Sign-in could not be verified', 'Close this tab and try Google sign-in again.');
          reject(new Error('Google returned an invalid sign-in callback. Try again.'));
          return;
        }
        serveCallbackPage(response, 'Google authorization received', 'Return to Tawny to finish signing in. You can close this tab.');
        resolve(code);
      });
    });

    const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizeUrl.search = new URLSearchParams({
      client_id: configuration().googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    }).toString();
    try {
      await shell.openExternal(authorizeUrl.toString());
    } catch {
      throw new Error('Tawny could not open your system browser. Check your default browser and try again.');
    }
    const code = await callbackResult;
    const googleIdToken = await exchangeGoogleCode(code, verifier, redirectUri);
  const newSession = await exchangeFirebaseCredential(googleIdToken, 'http://localhost');
    await persistSession(newSession);
    sessionGeneration += 1;
    session = newSession;
    return publicProfile()!;
  } finally {
    rejectPendingSignIn = undefined;
    disposePendingServer();
  }
}

export async function cancelGoogleSignIn(): Promise<void> {
  rejectPendingSignIn?.(new Error('Google sign-in was cancelled.'));
  rejectPendingSignIn = undefined;
  disposePendingServer();
}

export async function getAuthProfile(): Promise<AuthProfile | undefined> {
  if (!session) {
    if (!configIsReady() || !hasSecureStorage()) return undefined;
    try {
      const encrypted = await readFile(sessionPath());
      const stored = JSON.parse(safeStorage.decryptString(encrypted)) as StoredSession;
      if (!stored.refreshToken || !stored.idToken || !stored.email) throw new Error('Invalid saved session.');
      session = stored;
    } catch {
      return undefined;
    }
  }

  const profile = publicProfile();
  if (session && session.expiresAt <= Date.now() + 120_000 && !refreshPromise) {
    // Return the encrypted local identity immediately; refresh in the background so
    // an offline or slow Firebase request never holds the app's first window open.
    const current = session;
    const generation = sessionGeneration;
    refreshPromise = (async () => {
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
      try {
        const response = await fetch(`${FIREBASE_TOKEN_URL}?key=${encodeURIComponent(configuration().apiKey)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(12_000)
        });
        const refreshed = await readResponse(response, 'Firebase session refresh');
        if (typeof refreshed.id_token !== 'string' || typeof refreshed.refresh_token !== 'string') {
          throw new Error('Firebase returned an incomplete session refresh.');
        }
        if (generation !== sessionGeneration || session !== current) return;
        const nextSession = {
          ...current,
          idToken: refreshed.id_token,
          refreshToken: refreshed.refresh_token,
          expiresAt: Date.now() + Number(refreshed.expires_in ?? 3600) * 1000
        };
        await persistSession(nextSession);
        if (generation === sessionGeneration && session === current) session = nextSession;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (generation === sessionGeneration && session === current
          && (message.includes('saved sign-in has expired') || message.includes('Firebase rejected the app configuration'))) {
          await clearPersistedSession();
          sessionInvalidatedHandler?.();
        }
        // Keep the encrypted local identity on temporary network/storage errors.
      }
    })().finally(() => { refreshPromise = undefined; });
  }
  return profile;
}

export async function signOut(): Promise<void> {
  disposePendingServer();
  await clearPersistedSession();
}
