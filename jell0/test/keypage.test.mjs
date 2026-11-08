// The jell0 key page, end to end against a real SQLite (node:sqlite) behind a D1-shaped shim.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import worker from '../src/index.js'
import { clearKeyCache } from '../src/keys.js'

function d1() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE jell0_keys (hash TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT, hint TEXT NOT NULL DEFAULT '', lanes TEXT NOT NULL DEFAULT '', expires_at TEXT, disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE jell0_admin (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, pw_hash TEXT NOT NULL, salt TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, temp_expires TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE jell0_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0);`)
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  })
  return { raw: db, prepare: sql => stmt(sql) }
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

import { pbkdf2 } from '../src/keypage.js'
async function seedAdmin(db, temp) {
  const salt = '00112233445566778899aabbccddeeff'
  db.raw.prepare("INSERT INTO jell0_admin (id, username, pw_hash, salt, must_change, temp_expires) VALUES (1, 'owner', ?, ?, 1, datetime('now', '+2 days'))").run(await pbkdf2(temp, salt), salt)
}
const ask = (model, key) => [ '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer ' + key } ]

test('token manager: temp password forces a new one, mint with limits, lanes enforced, off, retire', async () => {
  const db = d1(); const env = envWith(db); cookie = ''
  await seedAdmin(db, 'temporary-pass-123')
  assert.match((await call(env, '/keys')).body, /jell0 API token manager/)
  assert.equal((await call(env, '/keys/api/login', { username: 'owner', password: 'nope-nope-nope' })).status, 401)
  assert.equal((await call(env, '/keys/api/login', { username: 'other', password: 'temporary-pass-123' })).status, 401)
  const first = await call(env, '/keys/api/login', { username: 'Owner ', password: 'temporary-pass-123' })
  assert.equal(first.body.mustChange, true)
  assert.equal((await call(env, '/keys/api/mint', { label: 'x' })).status, 403, 'nothing works before the password is changed')
  assert.equal((await call(env, '/keys/api/password', { password: 'short' })).status, 400)
  assert.equal((await call(env, '/keys/api/password', { password: 'my-own-password-99' })).status, 200)
  assert.equal(db.raw.prepare('SELECT must_change FROM jell0_admin').get().must_change, 0)

  const fast = await call(env, '/keys/api/mint', { label: 'fast only', lanes: ['fast', 'nonsense'], days: 30 })
  const any = await call(env, '/keys/api/mint', { label: 'everything' })
  assert.match(fast.body.key, /^jell0-[0-9a-f]{64}$/)
  const rows = db.raw.prepare('SELECT label, lanes, expires_at FROM jell0_keys ORDER BY label').all()
  assert.deepEqual(rows.map(r => r.lanes), ['', 'fast'])
  assert.ok(rows.find(r => r.label === 'fast only').expires_at)
  assert.ok(!JSON.stringify(db.raw.prepare('SELECT * FROM jell0_keys').all()).includes(fast.body.key))

  const keep = cookie; cookie = ''; clearKeyCache()
  assert.equal((await call(env, ...ask('jell0-fast', fast.body.key))).status, 200)
  assert.equal((await call(env, ...ask('jell0-flagship', fast.body.key))).status, 403, 'lane outside the token limits')
  assert.equal((await call(env, ...ask('jell0-flagship', any.body.key))).status, 200)
  cookie = keep

  const list = (await call(env, '/keys/api/list')).body.keys
  const f = list.find(k => k.label === 'fast only')
  assert.equal((await call(env, '/keys/api/update', { id: f.id, lanes: 'fast', disabled: true })).body.changed, 1)
  cookie = ''; assert.equal((await call(env, ...ask('jell0-fast', fast.body.key))).status, 401, 'turned off'); cookie = keep
  const a = list.find(k => k.label === 'everything')
  assert.equal((await call(env, '/keys/api/revoke', { id: a.id })).body.changed, 1)
  cookie = ''; assert.equal((await call(env, ...ask('jell0-fast', any.body.key))).status, 401, 'retired'); cookie = keep

  assert.equal((await call(env, '/keys/api/logout', {})).status, 200)
  cookie = ''
  assert.equal((await call(env, '/keys/api/list')).status, 401)
  assert.equal((await call(env, '/keys/api/login', { username: 'owner', password: 'temporary-pass-123' })).status, 401, 'temp password is gone')
  assert.equal((await call(env, '/keys/api/login', { username: 'owner', password: 'my-own-password-99' })).body.mustChange, false)
})

test('token manager: an expired temporary password is refused', async () => {
  const db = d1(); const env = envWith(db); cookie = ''
  await seedAdmin(db, 'temporary-pass-123')
  db.raw.exec("UPDATE jell0_admin SET temp_expires = datetime('now', '-1 hour')")
  assert.equal((await call(env, '/keys/api/login', { username: 'owner', password: 'temporary-pass-123' })).status, 401)
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
