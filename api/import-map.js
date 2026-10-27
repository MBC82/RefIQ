// api/import-map.js — AI column-mapping proxy for spreadsheet import
// Accepts: POST { headers: string[] }
// Returns: { mapping: { "Header": "fieldName"|null, ... } }
// Env var required: ANTHROPIC_API_KEY

// <guard> — identical in api/quiz.js, api/ai-suggest.js and api/import-map.js (a test keeps the copies the same).
// Each endpoint file stands alone because Vercel loads these files as CommonJS and cannot require a shared ES module.
const PROJECT = 'refiq-b8142';
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();                         // key -> timestamps. Per server instance: a best-effort brake, not a ledger.

/** True if `key` may make another request now. Records the request when it allows it. */
function rateLimit(key, limit, now = Date.now(), store = hits, windowMs = WINDOW_MS) {
  const recent = (store.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length >= limit) { store.set(key, recent); return false; }
  recent.push(now);
  store.set(key, recent);
  if (store.size > 5000) for (const [k, v] of store) if (!v.some(t => now - t < windowMs)) store.delete(k);   // keep memory bounded
  return true;
}

/** Google checks the token's signature and expiry for us. Returns the person's uid, or null. */
async function verifyIdToken(token, apiKey, fetchFn = fetch) {
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
async function activeQuizLink(id, fetchFn = fetch, project = PROJECT) {
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
function badQuizBody(body, { maxChars = 30000 } = {}) {
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
async function authorize(req, body, { allowQuizLink = false, perUser = 60, perLink = 150, fetchFn = fetch, env = process.env, now = Date.now(), store = hits } = {}) {
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
// </guard>

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API not configured' });

  const gate = await authorize(req, req.body, { perUser: 60 });      // league admins only: must be signed in
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const { headers } = req.body || {};
  if (!Array.isArray(headers) || !headers.length) {
    return res.status(400).json({ error: 'headers array is required' });
  }

  const prompt = `You are mapping spreadsheet column headers to game assignment fields.

Headers from the spreadsheet: ${JSON.stringify(headers)}

Map each header to the closest matching field from this list:
- date (game date)
- time (game time)
- homeTeam (home team name)
- awayTeam (away team or visiting team name)
- division (age group or division like U10, U12, rec-5th6th, etc)
- location (field name or address)
- notes (any additional notes or comments)

Rules:
- Every header must map to exactly one field from the list above, or null if it clearly doesn't match anything
- Return ONLY a valid JSON object like: {"Header Name": "fieldName", "Another Header": null}
- No explanation, no markdown, no code fences — just the raw JSON object`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await aiRes.json();
    if (!aiRes.ok) {
      return res.status(aiRes.status).json({ error: data.error?.message || 'AI error' });
    }

    const text = data.content?.[0]?.text?.trim() || '{}';
    let mapping;
    try {
      mapping = JSON.parse(text);
    } catch(_) {
      // Try to extract JSON from the response if model added any text around it
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      mapping = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    }

    return res.status(200).json({ mapping });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
