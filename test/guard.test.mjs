import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The guard lives inside each endpoint file (see the markers). Test the copy in api/quiz.js, and that the copies match.
const ENDPOINTS = ['api/quiz.js', 'api/ai-suggest.js', 'api/import-map.js'];
const guardText = file => { const s = readFileSync(file, 'utf8'); return s.slice(s.indexOf('// <guard>'), s.indexOf('// </guard>')); };
const dir = mkdtempSync(join(tmpdir(), 'refiq-guard-'));
writeFileSync(join(dir, 'guard.mjs'), guardText('api/quiz.js') + '\nexport { rateLimit, verifyIdToken, activeQuizLink, badQuizBody, authorize };\n');
const { rateLimit, verifyIdToken, activeQuizLink, badQuizBody, authorize } = await import(pathToFileURL(join(dir, 'guard.mjs')).href);

test('every endpoint carries the same guard, and none imports a local file (Vercel loads them as CommonJS)', () => {
  const first = guardText(ENDPOINTS[0]);
  assert.ok(first.includes('async function authorize'));
  for (const f of ENDPOINTS) {
    assert.equal(guardText(f), first, `${f} has a different guard`);
    assert.equal(/^import\s/m.test(readFileSync(f, 'utf8')), false, `${f} must not import anything: a local ES module crashes on Vercel`);
    assert.ok(readFileSync(f, 'utf8').includes('await authorize('), `${f} must call the guard`);
  }
});

const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const env = { FIREBASE_API_KEY: 'key' };
const req = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
const good = { messages: [{ role: 'user', content: 'Make 5 questions' }] };

test('rate limit lets a caller through until the limit, then waits for the hour to pass', () => {
  const store = new Map();
  for (let i = 0; i < 3; i++) assert.equal(rateLimit('a', 3, 1000 + i, store), true);
  assert.equal(rateLimit('a', 3, 2000, store), false);
  assert.equal(rateLimit('b', 3, 2000, store), true, 'other callers are not affected');
  assert.equal(rateLimit('a', 3, 1000 + 3600001, store), true, 'an hour later it is fine again');
});

test('a Firebase token is accepted only when Google says it is valid', async () => {
  const ok = async () => json({ users: [{ localId: 'uid1' }] });
  assert.equal(await verifyIdToken('t', 'key', ok), 'uid1');
  assert.equal(await verifyIdToken('t', 'key', async () => json({ error: 'bad' }, 400)), null);
  assert.equal(await verifyIdToken('t', 'key', async () => { throw new Error('offline'); }), null);
  assert.equal(await verifyIdToken('', 'key', ok), null);
  assert.equal(await verifyIdToken('t', undefined, ok), null, 'no api key configured means nobody gets in');
});

test('a quiz link counts when it exists and is not switched off', async () => {
  const live = async () => json({ fields: { active: { booleanValue: true } } });
  const off = async () => json({ fields: { active: { booleanValue: false } } });
  const noFlag = async () => json({ fields: {} });
  assert.equal(await activeQuizLink('u12-4kxz', live), true);
  assert.equal(await activeQuizLink('u12-4kxz', noFlag), true, 'older links have no active flag');
  assert.equal(await activeQuizLink('u12-4kxz', off), false);
  assert.equal(await activeQuizLink('../etc', live), false, 'odd ids are rejected before any lookup');
  assert.equal(await activeQuizLink(undefined, live), false);
  assert.equal(await activeQuizLink('u12-4kxz', async () => json({}, 500)), false);
});

test('the oldest links are found by their short code', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push(url);
    if (url.includes(':runQuery')) return json([{ document: { fields: { active: { booleanValue: true } } } }]);
    return json({}, 404);
  };
  assert.equal(await activeQuizLink('legacy-code', fetchFn), true);
  assert.equal(calls.length, 2);
  assert.equal(await activeQuizLink('missing', async url => url.includes(':runQuery') ? json([{ readTime: 'x' }]) : json({}, 404)), false);
});

test('only a plain quiz request is accepted', () => {
  assert.equal(badQuizBody(good), null);
  assert.ok(badQuizBody(null)); assert.ok(badQuizBody({}));
  assert.ok(badQuizBody({ messages: [] })); assert.ok(badQuizBody({ messages: [good.messages[0], good.messages[0]] }));
  assert.ok(badQuizBody({ messages: [{ role: 'assistant', content: 'x' }] }));
  assert.ok(badQuizBody({ messages: [{ role: 'user', content: 'x'.repeat(30001) }] }), 'too big');
  assert.ok(badQuizBody({ ...good, system: 'x'.repeat(2001) }));
});

test('a stranger with nothing is turned away', async () => {
  const r = await authorize(req(), good, { allowQuizLink: true, env, fetchFn: async () => json({}) });
  assert.deepEqual([r.ok, r.status], [false, 401]);
});

test('a signed-in person gets through; a bad token does not', async () => {
  const fetchFn = async url => url.includes('accounts:lookup') ? json({ users: [{ localId: 'uid1' }] }) : json({}, 404);
  const ok = await authorize(req('good'), good, { env, fetchFn, store: new Map() });
  assert.deepEqual([ok.ok, ok.who], [true, 'user:uid1']);
  const bad = await authorize(req('bad'), good, { env, fetchFn: async () => json({ error: 'x' }, 400), store: new Map() });
  assert.deepEqual([bad.ok, bad.status], [false, 401]);
});

test('a signed-in person is slowed down after too many requests', async () => {
  const fetchFn = async () => json({ users: [{ localId: 'uid1' }] });
  const store = new Map();
  for (let i = 0; i < 5; i++) assert.equal((await authorize(req('t'), good, { env, fetchFn, perUser: 5, store })).ok, true);
  const r = await authorize(req('t'), good, { env, fetchFn, perUser: 5, store });
  assert.deepEqual([r.ok, r.status], [false, 429]);
});

test('a referee on a live quiz link gets through, but only where links are allowed', async () => {
  const fetchFn = async () => json({ fields: { active: { booleanValue: true } } });
  const body = { ...good, quizLinkId: 'u12-4kxz' };
  const ok = await authorize(req(), body, { allowQuizLink: true, env, fetchFn, store: new Map() });
  assert.deepEqual([ok.ok, ok.who], [true, 'link:u12-4kxz']);
  const other = await authorize(req(), body, { allowQuizLink: false, env, fetchFn, store: new Map() });
  assert.deepEqual([other.ok, other.status], [false, 401], 'the admin-only tools never accept a link id');
});

test('a dead quiz link is refused, and one link cannot be hammered', async () => {
  const off = async () => json({ fields: { active: { booleanValue: false } } });
  const body = { ...good, quizLinkId: 'u12-4kxz' };
  const dead = await authorize(req(), body, { allowQuizLink: true, env, fetchFn: off, store: new Map() });
  assert.deepEqual([dead.ok, dead.status], [false, 403]);
  const live = async () => json({ fields: {} });
  const store = new Map();
  for (let i = 0; i < 3; i++) assert.equal((await authorize(req(), body, { allowQuizLink: true, perLink: 3, env, fetchFn: live, store })).ok, true);
  assert.equal((await authorize(req(), body, { allowQuizLink: true, perLink: 3, env, fetchFn: live, store })).status, 429);
});

test('a valid token wins over a link id (a signed-in admin is never counted against a quiz)', async () => {
  const fetchFn = async url => url.includes('accounts:lookup') ? json({ users: [{ localId: 'uid1' }] }) : json({}, 404);
  const r = await authorize(req('t'), { ...good, quizLinkId: 'whatever' }, { allowQuizLink: true, env, fetchFn, store: new Map() });
  assert.equal(r.who, 'user:uid1');
});
