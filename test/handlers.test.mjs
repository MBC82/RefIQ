// Runs the real endpoint files with a pretend network, to prove a stranger never reaches Anthropic.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const guardUrl = pathToFileURL(resolve('lib/guard.mjs')).href;
const dir = mkdtempSync(join(tmpdir(), 'refiq-api-'));
async function load(name) {
  const src = readFileSync(`api/${name}.js`, 'utf8').replace("'../lib/guard.mjs'", `'${guardUrl}'`);
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, src);
  return (await import(pathToFileURL(file).href + `?t=${Math.random()}`)).default;
}

process.env.ANTHROPIC_API_KEY = 'sk-test'; process.env.FIREBASE_API_KEY = 'fb-key';
let anthropicCalls = 0;
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
beforeEach(() => {
  anthropicCalls = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com')) { anthropicCalls++; return json({ content: [{ type: 'text', text: '[]' }] }); }
    if (String(url).includes('accounts:lookup')) return json(JSON.parse(opts.body).idToken === 'good' ? { users: [{ localId: 'uid1' }] } : { error: 'bad' }, JSON.parse(opts.body).idToken === 'good' ? 200 : 400);
    if (String(url).includes('/quizLinks/live-link')) return json({ fields: { active: { booleanValue: true } } });
    return json({}, 404);
  };
});
function call(handler, { method = 'POST', headers = {}, body } = {}) {
  return new Promise(async resolveRes => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(d) { resolveRes({ code: this.code, body: d }); }, end() { resolveRes({ code: this.code }); } };
    await handler({ method, headers, body }, res);
  });
}
const quiz = { messages: [{ role: 'user', content: 'Make 5 questions' }], max_tokens: 2000 };

test('quiz: a stranger is refused and Anthropic is never called', async () => {
  const h = await load('quiz');
  const r = await call(h, { body: quiz });
  assert.equal(r.code, 401); assert.equal(anthropicCalls, 0);
});

test('quiz: a signed-in person is served', async () => {
  const h = await load('quiz');
  const r = await call(h, { headers: { authorization: 'Bearer good' }, body: quiz });
  assert.equal(r.code, 200); assert.equal(anthropicCalls, 1);
});

test('quiz: a bad token is refused', async () => {
  const h = await load('quiz');
  const r = await call(h, { headers: { authorization: 'Bearer forged' }, body: quiz });
  assert.equal(r.code, 401); assert.equal(anthropicCalls, 0);
});

test('quiz: a referee on a live shared link is served; a made-up link is not', async () => {
  const h = await load('quiz');
  assert.equal((await call(h, { body: { ...quiz, quizLinkId: 'live-link' } })).code, 200);
  const fake = await call(h, { body: { ...quiz, quizLinkId: 'made-up-id' } });
  assert.equal(fake.code, 403); assert.equal(anthropicCalls, 1);
});

test('quiz: oversized or odd requests are refused before anything is spent', async () => {
  const h = await load('quiz');
  const big = await call(h, { headers: { authorization: 'Bearer good' }, body: { messages: [{ role: 'user', content: 'x'.repeat(40000) }] } });
  assert.equal(big.code, 400);
  const many = await call(h, { headers: { authorization: 'Bearer good' }, body: { messages: [quiz.messages[0], quiz.messages[0]] } });
  assert.equal(many.code, 400); assert.equal(anthropicCalls, 0);
});

test('quiz: only POST is allowed', async () => {
  const h = await load('quiz');
  assert.equal((await call(h, { method: 'GET' })).code, 405);
});

test('ai-suggest and import-map: signed-in admins only, and a link id does not count', async () => {
  const suggest = await load('ai-suggest'), map = await load('import-map');
  const sBody = { game: { homeTeam: 'A', awayTeam: 'B' }, refs: [{ name: 'Pat', cert: 'Grade 8', scores: [80] }] };
  const mBody = { headers: ['Date', 'Home'] };
  for (const [h, b] of [[suggest, sBody], [map, mBody]]) {
    assert.equal((await call(h, { body: b })).code, 401);
    assert.equal((await call(h, { body: { ...b, quizLinkId: 'live-link' } })).code, 401, 'a quiz link is not an admin login');
  }
  assert.equal(anthropicCalls, 0);
  assert.equal((await call(suggest, { headers: { authorization: 'Bearer good' }, body: sBody })).code, 200);
  assert.equal((await call(map, { headers: { authorization: 'Bearer good' }, body: mBody })).code, 200);
  assert.equal(anthropicCalls, 2);
});
