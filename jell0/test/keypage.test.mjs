// The jell0 key page, end to end against a real SQLite (node:sqlite) behind a D1-shaped shim.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import worker from '../src/index.js'
import { clearKeyCache } from '../src/keys.js'

function d1() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE jell0_keys (hash TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT, hint TEXT NOT NULL DEFAULT '');
CREATE TABLE jell0_admin (id INTEGER PRIMARY KEY CHECK (id = 1), pw_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE jell0_setup (id INTEGER PRIMARY KEY CHECK (id = 1), open_until TEXT NOT NULL);
CREATE TABLE jell0_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);`)
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  })
  return { raw: db, prepare: sql => stmt(sql.replace(/\?\d+/g, '?')) }
}

function envWith(db) {
  return {
    JELL0_DB: db,
    JELL0_CONFIG: { async get() { return null }, async list() { return { keys: [], list_complete: true } } },
    AI: { async run() { return { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } } },
  }
}

const BASE = 'https://jell0.test'
let cookie = ''
async function call(env, path, data, extra = {}) {
  const init = data === undefined ? { headers: {} } : { method: 'POST', headers: { 'content-type': 'application/json', Origin: BASE }, body: JSON.stringify(data) }
  if (cookie) init.headers.Cookie = cookie
  Object.assign(init.headers, extra)
  const res = await worker.fetch(new Request(BASE + path, init), env)
  const set = res.headers.get('Set-Cookie')
  if (set) cookie = set.split(';')[0]
  return { status: res.status, body: res.headers.get('Content-Type')?.includes('json') ? await res.json() : await res.text() }
}

test('key page: setup window, password, mint, use, revoke, sign out', async () => {
  const db = d1(); const env = envWith(db); cookie = ''
  const page = await call(env, '/keys')
  assert.equal(page.status, 200)
  assert.match(page.body, /jell0 keys/)

  // No setup window: setup refused.
  assert.equal((await call(env, '/keys/api/setup', { password: 'a-long-password-1' })).status, 403)
  db.raw.exec("INSERT INTO jell0_setup (id, open_until) VALUES (1, datetime('now', '+15 minutes'))")
  assert.equal((await call(env, '/keys/api/setup', { password: 'short' })).status, 400)
  assert.equal((await call(env, '/keys/api/setup', { password: 'a-long-password-1' })).status, 200)
  // Second setup refused even with a window.
  db.raw.exec("INSERT OR REPLACE INTO jell0_setup (id, open_until) VALUES (1, datetime('now', '+15 minutes'))")
  assert.equal((await call(env, '/keys/api/setup', { password: 'another-password-2' })).status, 409)

  const minted = await call(env, '/keys/api/mint', { label: 'box cataloger' })
  assert.equal(minted.status, 200)
  assert.match(minted.body.key, /^jell0-[0-9a-f]{64}$/)
  const stored = db.raw.prepare('SELECT * FROM jell0_keys').all()
  assert.equal(stored.length, 1)
  assert.ok(!JSON.stringify(stored).includes(minted.body.key), 'the key itself is never stored')

  // The minted key works on a model route.
  clearKeyCache()
  const savedCookie = cookie; cookie = ''
  const chat = await call(env, '/v1/chat/completions', { model: 'jell0-fast', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + minted.body.key })
  assert.equal(chat.status, 200)
  cookie = savedCookie

  const list = await call(env, '/keys/api/list')
  assert.equal(list.body.keys[0].label, 'box cataloger')
  assert.equal(list.body.keys[0].hint, minted.body.key.slice(-4))
  assert.ok(!JSON.stringify(list.body).includes(minted.body.key))

  assert.equal((await call(env, '/keys/api/revoke', { id: list.body.keys[0].id })).body.revoked, 1)
  clearKeyCache(); const keep = cookie; cookie = ''
  assert.equal((await call(env, '/v1/chat/completions', { model: 'jell0-fast', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + minted.body.key })).status, 401)
  cookie = keep

  assert.equal((await call(env, '/keys/api/logout', {})).status, 200)
  cookie = ''
  assert.equal((await call(env, '/keys/api/mint', { label: 'x' })).status, 401)
  assert.equal((await call(env, '/keys/api/login', { password: 'wrong-password-xx' })).status, 401)
  assert.equal((await call(env, '/keys/api/login', { password: 'a-long-password-1' })).status, 200)
  assert.equal((await call(env, '/keys/api/list')).status, 200)
})

test('key page: no session, forged cookie or other origin cannot mint', async () => {
  const db = d1(); const env = envWith(db); cookie = ''
  assert.equal((await call(env, '/keys/api/mint', { label: 'x' })).status, 401)
  cookie = 'jell0_session=' + 'a'.repeat(64)
  assert.equal((await call(env, '/keys/api/mint', { label: 'x' })).status, 401)
  cookie = ''
  const res = await worker.fetch(new Request(BASE + '/keys/api/login', { method: 'POST', headers: { Origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{"password":"x"}' }), env)
  assert.equal(res.status, 403)
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM jell0_keys').get().n, 0)
})
