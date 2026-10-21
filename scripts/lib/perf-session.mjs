// A temporary, revocable app session for the performance profiler.
//
// The profiler has to load real chats as a signed-in browser so it can time the
// app's own endpoints. It never asks for the user's password and never touches
// an existing session: it mints ONE extra session row for the account that is
// already configured (`access_sessions`), sets that cookie on the profiling
// tab, and deletes the row again when the run ends. Nothing else is written.
//
// If access auth is not enabled the app needs no cookie at all, and this
// module reports that instead of inventing one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function homeDir() {
  return process.env.MOUAIF_HOME || path.join(os.homedir(), '.mouaif');
}

// probe(base) -> { authEnabled, authenticated }
//
// Uses a cookie-less fetch, so it answers "would an anonymous request work".
export async function probe(base) {
  try {
    const res = await fetch(base + '/api/access/status');
    const body = await res.json();
    return { authEnabled: body.authEnabled !== false, configured: body.configured !== false, status: res.status };
  } catch (e) {
    return { error: e.message };
  }
}

// withSession(fn) — run fn({ cookie | null }) with a session minted for the
// duration, revoking it afterwards. `mode: 'none'` means the app needs no
// cookie; nothing was written.
export async function withSession(base, fn) {
  const status = await probe(base);
  if (status.error) throw new Error('cannot reach ' + base + ': ' + status.error);
  if (!status.authEnabled) {
    return { mode: 'none', result: await fn({ cookie: null }) };
  }
  // The store is the same file the server uses; open it the way the app does
  // so the session row it writes is identical to a real sign-in.
  process.env.MOUAIF_HOME = process.env.MOUAIF_HOME || homeDir();
  const accessAuth = require('../../src/access-auth.js');
  if (!accessAuth.configured()) {
    throw new Error('access auth is enabled but no account is configured in ' + homeDir()
      + ' — sign in to ' + base + ' once, then re-run the profiler');
  }
  const { token, expiresAt } = accessAuth.issueSession();
  const cookie = 'mouaif_access=' + token;
  // Confirm the cookie actually authenticates before measuring anything: a
  // profile of the sign-in screen looks plausible but measures nothing at all.
  const check = await fetch(base + '/api/access/status', { headers: { cookie } });
  const body = await check.json().catch(() => ({}));
  if (!body.authenticated) {
    accessAuth.revokeSession(token);
    throw new Error('the temporary profiling session was not accepted by ' + base
      + ' (is it the same store as ' + homeDir() + '?)');
  }
  try {
    const result = await fn({ cookie, expiresAt });
    return { mode: 'session', result };
  } finally {
    try { accessAuth.revokeSession(token); } catch { /* already gone */ }
  }
}

// exists(path) — small helper for callers that want to report where a store is.
export function storeExists() {
  try { return fs.statSync(path.join(homeDir(), 'store.sqlite')).isFile(); } catch { return false; }
}
