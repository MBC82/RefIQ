// lib/guard.js — decides whether a request to an AI endpoint may go through.
//
// The AI endpoints spend the site's Anthropic credit, so they never answer a stranger:
//   - a signed-in person sends their Firebase ID token ("Authorization: Bearer ..."), which we check with Google; or
//   - a referee opening a shared quiz link (no account) sends that link's id, and we check the link exists and is on.
// Either way the caller is rate limited and the request body is size checked.

const PROJECT = 'refiq-b8142';
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();                         // key -> timestamps. Per server instance: a best-effort brake, not a ledger.

/** True if `key` may make another request now. Records the request when it allows it. */
export function rateLimit(key, limit, now = Date.now(), store = hits, windowMs = WINDOW_MS) {
  const recent = (store.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length >= limit) { store.set(key, recent); return false; }
  recent.push(now);
  store.set(key, recent);
  if (store.size > 5000) for (const [k, v] of store) if (!v.some(t => now - t < windowMs)) store.delete(k);   // keep memory bounded
  return true;
}

/** Google checks the token's signature and expiry for us. Returns the person's uid, or null. */
export async function verifyIdToken(token, apiKey, fetchFn = fetch) {
  if (!token || !apiKey) return null;
  try {
    const r = await fetchFn(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.users?.[0]?.localId || null;
  } catch { return null; }
}

/**
 * Quiz links are public to read, so no credentials are needed to ask whether one exists and is switched on.
 * Newer links are documents named by their code in `quizLinks`; the oldest live in `quiz_links`, found by `shortCode`.
 */
export async function activeQuizLink(id, fetchFn = fetch, project = PROJECT) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,100}$/.test(id)) return false;
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  try {
    const r = await fetchFn(`${base}/quizLinks/${encodeURIComponent(id)}`);
    if (r.ok) return (await r.json())?.fields?.active?.booleanValue !== false;
    if (r.status !== 404) return false;
    const q = await fetchFn(`${base}:runQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'quiz_links' }],
        where: { fieldFilter: { field: { fieldPath: 'shortCode' }, op: 'EQUAL', value: { stringValue: id } } }, limit: 1 } }),
    });
    if (!q.ok) return false;
    const doc = (await q.json())?.find?.(x => x.document)?.document;
    return !!doc && doc.fields?.active?.booleanValue !== false;
  } catch { return false; }
}

/** Returns an error message if the body isn't a plain quiz request, or null if it is fine. */
export function badQuizBody(body, { maxChars = 30000 } = {}) {
  if (!body || typeof body !== 'object') return 'Invalid JSON.';
  const m = body.messages;
  if (!Array.isArray(m) || m.length !== 1) return 'Send exactly one message.';
  if (m[0]?.role !== 'user' || typeof m[0].content !== 'string') return 'The message must be text from the user.';
  if (m[0].content.length > maxChars) return 'That request is too large.';
  if (body.system !== undefined && (typeof body.system !== 'string' || body.system.length > 2000)) return 'Invalid system text.';
  return null;
}

/**
 * The one check every AI endpoint runs first.
 * Returns { ok: true, who } to carry on, or { ok: false, status, error } to answer with.
 */
export async function authorize(req, body, { allowQuizLink = false, perUser = 60, perLink = 150, fetchFn = fetch, env = process.env, now = Date.now(), store = hits } = {}) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (token) {
    const uid = await verifyIdToken(token, env.FIREBASE_API_KEY, fetchFn);
    if (!uid) return { ok: false, status: 401, error: 'Please sign in again.' };
    if (!rateLimit(`u:${uid}`, perUser, now, store)) return { ok: false, status: 429, error: 'Too many requests. Please wait a bit and try again.' };
    return { ok: true, who: `user:${uid}` };
  }

  if (allowQuizLink && body?.quizLinkId) {
    if (!(await activeQuizLink(body.quizLinkId, fetchFn))) return { ok: false, status: 403, error: 'This quiz link is not active.' };
    if (!rateLimit(`l:${body.quizLinkId}`, perLink, now, store)) return { ok: false, status: 429, error: 'This quiz is busy right now. Please try again in a few minutes.' };
    return { ok: true, who: `link:${body.quizLinkId}` };
  }

  return { ok: false, status: 401, error: 'Please sign in.' };
}
