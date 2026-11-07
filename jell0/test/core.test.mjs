// Core tests for jell0: auth, admin lock, routing, the Workers AI runner,
// the max_tokens cap, env reads and literal secrets. Run: node --test test/
// Fake env only: a KV map, an AI mock with run(), a D1 mock. No network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import worker from '../src/index.js'
import { MODELS, LANES, LANE_NAMES, resolveTarget, chainFor, modelList, estimateTokens, fits, planRoute, classify } from '../src/catalog.js'
import { runChain, buildInput, nearestEffort, MAX_TOKENS_CAP, DEFAULT_MAX_TOKENS } from '../src/workersai.js'
import * as keys from '../src/keys.js'
import { sha256hex, managerKeyOk, clearKeyCache } from '../src/keys.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const JELL0 = join(HERE, '..')
const REPO = join(JELL0, '..')

const GLM53 = '@cf/zai-org/glm-5.3'
const GLM52 = '@cf/zai-org/glm-5.2'
const DSV41 = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
const QWEN = '@cf/qwen/qwen3.8-27b'
const GEMMA = '@cf/google/gemma-4-26b-a4b-it'
const SCOUT = '@cf/meta/llama-4-scout-17b-16e-instruct'
const BEFORE = Date.parse('2026-11-10T00:00:00Z')
const AFTER = Date.parse('2026-11-20T00:00:01Z')

const ADMIN = 'jell0-admin-v2.test-admin-token-0123456789abcdef-0123456789' // v2 format: 40+ after the dot
const KV_KEY = 'kv-test-key-aaaaaaaaaaaaaaaa'
const KV_PLAIN = 'kv-old-plain-key-bbbbbbbbbbbb'
const h = s => createHash('sha256').update(s).digest('hex')

// Manager keys are shaped like the real ones: "llk_" plus 64 hex.
const mgr = s => 'llk_' + h('manager key ' + s)
const MGR_OK = mgr('with ai_models')
const MGR_NO = mgr('without ai_models')
const MGR_REVOKED = mgr('revoked')
const MGR_D1ERR = mgr('d1 error')

// ---------------------------------------------------------------- fakes

function okJSON(text = 'hello') {
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
}

function sseStream(events, { hold = false } = {}) {
  const enc = new TextEncoder()
  let ctl
  const s = new ReadableStream({
    start(c) {
      ctl = c
      for (const e of events) c.enqueue(enc.encode(e))
      if (!hold) c.close()
    },
  })
  s.push = e => ctl.enqueue(enc.encode(e))
  s.finish = () => ctl.close()
  return s
}

const data = obj => 'data: ' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n\n'

// KV fake: get, put (with metadata), delete, list by prefix.
function fakeKV(store) {
  const meta = new Map()
  return {
    async get(k) { return store.has(k) ? store.get(k) : null },
    async put(k, v, opts = {}) { store.set(k, v); meta.set(k, opts.metadata ?? null) },
    async delete(k) { store.delete(k); meta.delete(k) },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter(n => n.startsWith(prefix)).map(name => ({ name, metadata: meta.get(name) ?? JSON.parse(store.get(name)) })), list_complete: true }
    },
  }
}

function makeEnv({ ai, mgrRows, adminToken = ADMIN, strict = true } = {}) {
  const store = new Map()
  store.set('key:' + h(KV_KEY), JSON.stringify({ id: 'k1', label: 'hashed', hint: KV_KEY.slice(-4), created: '2026-11-07T00:00:00.000Z' }))
  store.set('api_keys', JSON.stringify([{ id: 'k2', label: 'old plain', key: KV_PLAIN }]))
  const aiCalls = []
  const sqls = []
  const rows = mgrRows ?? [
    { hash: h(MGR_OK), perms: 'ai_models', revoked_at: null },
    { hash: h(MGR_NO), perms: 'production,admin', revoked_at: null },
    { hash: h(MGR_REVOKED), perms: 'ai_models', revoked_at: '2026-11-01 00:00:00' },
  ]
  const base = {
    AI: {
      async run(id, input) {
        aiCalls.push({ id, input })
        return ai ? ai(id, input, aiCalls.length) : (input.stream ? sseStream([data({ response: 'hi' }), data('[DONE]')]) : okJSON())
      },
    },
    JELL0_CONFIG: fakeKV(store),
    MGR_DB: {
      prepare(sql) {
        sqls.push(sql)
        return {
          bind(...args) {
            return {
              async first() {
                if (args[0] === h(MGR_D1ERR)) throw new Error('D1 down')
                const live = /revoked_at IS NULL/.test(sql)
                return rows.find(r => r.hash === args[0] && (!live || r.revoked_at == null)) || null
              },
            }
          },
        }
      },
    },
  }
  if (adminToken !== undefined) base.JELL0_ADMIN_TOKEN = adminToken
  const allowed = new Set(['AI', 'JELL0_CONFIG', 'MGR_DB', 'JELL0_ADMIN_TOKEN', 'JELL0_IP_LIMIT', 'JELL0_KEY_LIMIT'])
  const env = strict
    ? new Proxy(base, {
        get(t, k) {
          if (typeof k === 'string' && !allowed.has(k)) throw new Error('jell0 read env.' + k)
          return t[k]
        },
      })
    : base
  return { env, aiCalls, sqls, store }
}

function req(path, { method = 'GET', body, headers = {} } = {}) {
  return new Request('https://jell0-router.example.workers.dev' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const bearer = k => ({ Authorization: 'Bearer ' + k })
const CHAT = { model: 'jell0-flagship', messages: [{ role: 'user', content: 'hello there' }] }
const chat = (env, headers, body = CHAT) => worker.fetch(req('/v1/chat/completions', { method: 'POST', body, headers }), env)
const MSG = { model: 'claude-opus-4-1', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }

// String literals in source text (group 2 is the content).
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g

// The old live bundle, when present (never in CI). Its secrets are read from it
// at run time and never printed or written anywhere; no file holds them or any
// hash of them. The phase A shared bearer (removed) is the literal the old
// isAuthed compared right after auth.slice(7).trim().
const BUNDLE = process.env.JELL0_BUNDLE || ''
function bundleSecrets() {
  if (!existsSync(BUNDLE)) return null
  const s = readFileSync(BUNDLE, 'utf8')
  const one = re => (re.exec(s) || [])[1] || null
  const b = /auth\.slice\(7\)\.trim\(\);[\s\S]{0,120}?key === (["'`])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(s)
  return {
    bearer: b ? b[2] : null,
    password: one(/pbkdf2\("([^"]+)", salt\)/),
    hmacFallback: one(/JELL0_ADMIN_TOKEN \|\| "([^"]+)"/),
  }
}

// ---------------------------------------------------------------- auth matrix

test('auth: no key and wrong key are 401 with an OpenAI error, and no model runs', async () => {
  const { env, aiCalls } = makeEnv()
  for (const headers of [{}, bearer('nope-not-a-key'), { 'x-api-key': 'nope' }, { Authorization: 'Basic abc' }]) {
    const r = await chat(env, headers)
    assert.equal(r.status, 401)
    const j = await r.json()
    assert.equal(j.error.code, 'invalid_api_key')
    assert.equal(typeof j.error.message, 'string')
  }
  assert.equal(aiCalls.length, 0)
})

test('auth: hashed KV keys work by bearer and x-api-key; plain entries from the old open jell0 do not', async () => {
  const { env } = makeEnv()
  assert.equal((await chat(env, bearer(KV_KEY))).status, 200)
  assert.equal((await chat(env, { 'x-api-key': KV_KEY })).status, 200)
  assert.equal((await chat(env, bearer(KV_PLAIN))).status, 401)
  assert.equal((await chat(env, { 'x-api-key': KV_PLAIN })).status, 401)
})

test('auth: Manager keys need ai_models, not revoked, D1 errors refuse; SELECT only', async () => {
  clearKeyCache()
  const { env, sqls } = makeEnv()
  assert.equal((await chat(env, bearer(MGR_OK))).status, 200)
  assert.equal((await chat(env, { 'x-api-key': MGR_OK })).status, 200)
  assert.equal((await chat(env, bearer(MGR_NO))).status, 401)
  assert.equal((await chat(env, bearer(MGR_REVOKED))).status, 401)
  assert.equal((await chat(env, bearer(MGR_D1ERR))).status, 401)
  assert.ok(sqls.length > 0)
  for (const s of sqls) assert.match(s, /^SELECT perms FROM mgr_api_key WHERE hash = \?1 AND revoked_at IS NULL/)
})

test('auth: Manager key results are cached for 60 s; D1 errors are not cached', async () => {
  clearKeyCache()
  const { env, sqls } = makeEnv({ strict: false })
  assert.equal(await managerKeyOk(env, MGR_OK), true)
  assert.equal(await managerKeyOk(env, MGR_OK), true)
  assert.equal(sqls.length, 1)
  assert.equal(await managerKeyOk(env, MGR_D1ERR), false)
  assert.equal(await managerKeyOk(env, MGR_D1ERR), false)
  assert.equal(sqls.length, 3)
  assert.equal(await managerKeyOk({}, MGR_OK), false) // no D1 binding
})

test('auth: the admin token is never a model key', async () => {
  const { env } = makeEnv()
  assert.equal((await chat(env, bearer(ADMIN))).status, 401)
  assert.equal((await chat(env, { 'x-api-key': ADMIN })).status, 401)
  const m = await worker.fetch(req('/v1/messages', { method: 'POST', body: MSG, headers: bearer(ADMIN) }), env)
  assert.equal(m.status, 401)
})

test('auth: the old shared bearer (phase A, removed) is 401 on every model route', async t => {
  const sec = bundleSecrets()
  if (!sec || !sec.bearer) return t.skip('old bundle not present')
  clearKeyCache()
  const { env, aiCalls } = makeEnv()
  for (const headers of [bearer(sec.bearer), { 'x-api-key': sec.bearer }]) {
    for (const path of ['/v1/chat/completions', '/chat/completions']) {
      for (const body of [CHAT, { ...CHAT, model: 'jell0-fast', stream: true }]) {
        const r = await worker.fetch(req(path, { method: 'POST', body, headers }), env)
        assert.equal(r.status, 401, path)
        assert.equal((await r.json()).error.code, 'invalid_api_key', path)
      }
    }
    for (const path of ['/v1/messages', '/messages', '/v1/messages/count_tokens']) {
      for (const body of [MSG, { ...MSG, model: 'claude-haiku-4-5', stream: true }]) {
        const r = await worker.fetch(req(path, { method: 'POST', body, headers }), env)
        assert.equal(r.status, 401, path)
        const j = await r.json()
        assert.equal(j.type, 'error', path)
        assert.equal(j.error.type, 'authentication_error', path)
      }
    }
  }
  assert.equal(aiCalls.length, 0)
})

test('auth: /v1/messages and count_tokens answer 401 with an Anthropic error body', async () => {
  const { env } = makeEnv()
  for (const path of ['/v1/messages', '/messages', '/v1/messages/count_tokens']) {
    const r = await worker.fetch(req(path, { method: 'POST', body: MSG }), env)
    assert.equal(r.status, 401)
    const j = await r.json()
    assert.equal(j.type, 'error')
    assert.equal(j.error.type, 'authentication_error')
  }
})

// ---------------------------------------------------------------- admin lock

test('admin: keys and session need the admin token', async () => {
  const { env } = makeEnv()
  const calls = [
    req('/api/jell0/keys'),
    req('/api/jell0/keys', { method: 'POST', body: { label: 'x' } }),
    req('/api/jell0/keys?id=k1', { method: 'DELETE' }),
    req('/api/jell0/session'),
  ]
  for (const r of calls) assert.equal((await worker.fetch(r, env)).status, 401)
  for (const k of [KV_KEY, MGR_OK, 'wrong-token-wrong-token-wrong-token-xx']) {
    assert.equal((await worker.fetch(req('/api/jell0/session', { headers: bearer(k) }), env)).status, 401)
  }
  assert.equal((await worker.fetch(req('/api/jell0/session', { headers: { 'x-api-key': ADMIN } }), env)).status, 401)
  const s = await worker.fetch(req('/api/jell0/session', { headers: bearer(ADMIN) }), env)
  assert.equal(s.status, 200)
  assert.equal((await s.json()).authed, true)
})

test('admin: a short or missing admin token turns admin off', async () => {
  const short = 'short-token'
  for (const adminToken of [short, '', undefined]) {
    const { env } = makeEnv({ adminToken })
    const r = await worker.fetch(req('/api/jell0/session', { headers: bearer(adminToken || 'x') }), env)
    assert.equal(r.status, 401)
  }
})

test('admin: create, list (no key or hash shown), use and delete a KV key', async () => {
  const { env, store } = makeEnv()
  const c = await worker.fetch(req('/api/jell0/keys', { method: 'POST', body: { label: 'box' }, headers: bearer(ADMIN) }), env)
  assert.equal(c.status, 200)
  const made = await c.json()
  assert.match(made.key, /^jell0-[0-9a-f]{48}$/)
  const stored = JSON.parse(store.get('key:' + h(made.key)))
  assert.equal(stored.id, made.id)
  assert.equal(stored.key, undefined)
  assert.ok(![...store.values()].some(v => v.includes(made.key)))
  const l = await (await worker.fetch(req('/api/jell0/keys', { headers: bearer(ADMIN) }), env)).text()
  assert.ok(!l.includes(made.key) && !l.includes(h(made.key)) && !l.includes(KV_PLAIN))
  assert.equal((await chat(env, bearer(made.key))).status, 200)
  const d = await worker.fetch(req('/api/jell0/keys?id=' + made.id, { method: 'DELETE', headers: bearer(ADMIN) }), env)
  assert.equal((await d.json()).removed, 1)
  assert.equal((await chat(env, bearer(made.key))).status, 401)
})

test('removed endpoints and the old console answer 404', async () => {
  const { env } = makeEnv()
  const gone = [
    ['/api/jell0/discover', 'GET'], ['/api/jell0/discover', 'POST'], ['/api/jell0/providers', 'GET'],
    ['/api/jell0/providers', 'POST'], ['/api/jell0/providers', 'DELETE'], ['/api/jell0/connect', 'POST'],
    ['/api/jell0/login', 'POST'], ['/api/jell0/password', 'POST'], ['/api/jell0/logout', 'POST'],
    ['/admin', 'GET'], ['/nope', 'GET'], ['/v1/chat/completions', 'GET'],
  ]
  for (const [path, method] of gone) {
    for (const headers of [{}, bearer(ADMIN)]) {
      const r = await worker.fetch(req(path, { method, headers, body: method === 'GET' ? undefined : {} }), env)
      assert.equal(r.status, 404, method + ' ' + path)
    }
  }
  const root = await worker.fetch(req('/'), env)
  assert.equal(root.status, 200)
  assert.match(root.headers.get('content-type'), /application\/json/)
  assert.equal((await root.json()).name, 'jell0-router')
  const health = await worker.fetch(req('/health'), env)
  assert.equal(health.status, 200)
  assert.equal(await health.text(), 'ok')
})

// ---------------------------------------------------------------- lanes and aliases

test('routing: every old lane name and the new ones resolve to a known lane', () => {
  const old = ['smart', 'budget', 'free', 'simple', 'coding', 'reasoning', 'flagship', 'classic', 'flatline', 'fast', 'long', 'vision', 'balanced', 'creative', 'general']
  for (const lane of [...old, 'max', 'glm']) {
    const t = resolveTarget('jell0-' + lane, BEFORE)
    assert.equal(t.known, true, lane)
    assert.equal(t.lane, lane)
    assert.ok(LANE_NAMES.includes(lane))
  }
  assert.equal(resolveTarget('JELL0', BEFORE).lane, 'smart')
  assert.equal(resolveTarget('jell0/coding', BEFORE).lane, 'coding')
  assert.equal(resolveTarget('', BEFORE).lane, 'smart')
  assert.deepEqual(resolveTarget('gpt-4o', BEFORE), { lane: 'smart', first: null, known: false })
})

test('routing: lane chains are all Cloudflare catalog models, as designed', () => {
  const ids = new Set(MODELS.map(m => m.id))
  for (const [lane, chain] of Object.entries(LANES)) {
    for (const id of chain) assert.ok(ids.has(id) && id.startsWith('@cf/'), lane + ' ' + id)
    assert.ok(!chain.includes(GLM52), 'glm-5.2 is never chosen automatically: ' + lane)
  }
  for (const lane of ['flagship', 'max', 'glm', 'coding']) assert.deepEqual(LANES[lane], [GLM53, DSV41, QWEN])
  assert.deepEqual(LANES.long, [DSV41, QWEN, GLM53])
  assert.deepEqual(LANES.reasoning, [DSV41, '@cf/openai/gpt-oss-120b', QWEN])
  assert.deepEqual(LANES.vision, [DSV41, QWEN, GEMMA, SCOUT])
  for (const lane of ['general', 'balanced', 'classic', 'creative']) assert.deepEqual(LANES[lane], [QWEN, DSV41, GEMMA])
  for (const lane of ['fast', 'simple', 'budget', 'free', 'flatline']) assert.deepEqual(LANES[lane], [GEMMA, '@cf/zai-org/glm-4.7-flash', '@cf/openai/gpt-oss-20b'])
})

test('routing: aliases and ids pick that model first, then its lane', () => {
  for (const name of ['glm-5.3', 'GLM-5.3', GLM53, 'zai-org/glm-5.3', 'jell0-glm-5.3']) {
    const t = resolveTarget(name, BEFORE)
    assert.equal(t.first, GLM53, name)
    assert.deepEqual(chainFor(t, {}, BEFORE), [GLM53, DSV41, QWEN])
  }
  // "glm" is both a lane and an alias of glm-5.3: same chain either way
  assert.deepEqual(chainFor(resolveTarget('glm', BEFORE), {}, BEFORE), [GLM53, DSV41, QWEN])
  const q = resolveTarget('qwen', BEFORE)
  assert.deepEqual(chainFor(q, {}, BEFORE), [QWEN, DSV41, GEMMA])
  const s = resolveTarget('llama-4-scout', BEFORE)
  assert.deepEqual(chainFor(s, {}, BEFORE), [SCOUT, DSV41, QWEN, GEMMA])
  for (const a of ['deepseek-v4.1-flash', 'deepseek', 'qwen3.8-27b', 'gemma-4-26b', 'gemma', 'gpt-oss-120b', 'gpt-oss-20b', 'glm-4.7-flash']) {
    assert.ok(resolveTarget(a, BEFORE).first, a)
  }
})

test('routing: claude-* names map on the Anthropic route only', () => {
  const a = { anthropic: true }
  assert.equal(resolveTarget('claude-opus-4-1', BEFORE, a).lane, 'flagship')
  assert.equal(resolveTarget('claude-sonnet-4-5', BEFORE, a).lane, 'flagship')
  assert.equal(resolveTarget('claude-3-5-haiku-latest', BEFORE, a).lane, 'fast')
  assert.equal(resolveTarget('claude-haiku-4-5', BEFORE, a).lane, 'fast')
  assert.equal(resolveTarget('glm-5.3', BEFORE, a).first, GLM53)
  assert.equal(resolveTarget('claude-opus-4-1', BEFORE).lane, 'smart')
})

test('routing: glm-5.2 before and after its 2026-11-20 retirement', () => {
  const before = resolveTarget('glm-5.2', BEFORE)
  assert.equal(before.first, GLM52)
  assert.deepEqual(chainFor(before, {}, BEFORE), [GLM52, GLM53, DSV41, QWEN])
  const after = resolveTarget('glm-5.2', AFTER)
  assert.equal(after.first, GLM53)
  assert.deepEqual(chainFor(after, {}, AFTER), [GLM53, DSV41, QWEN])
  assert.ok(modelList(BEFORE).some(m => m.id === 'glm-5.2'))
  assert.ok(!modelList(AFTER).some(m => m.id === 'glm-5.2' || m.id === GLM52))
})

test('routing: smart lane uses the keyword classifier; images go to vision', () => {
  assert.equal(classify([{ role: 'user', content: 'fix this python function bug' }]), 'coding')
  assert.equal(classify([{ role: 'user', content: [{ type: 'text', text: 'write a poem and a story' }] }]), 'creative')
  const p = planRoute({ model: 'jell0', messages: [{ role: 'user', content: 'debug my javascript code' }] }, {}, BEFORE)
  assert.equal(p.category, 'coding')
  assert.equal(p.lane, 'coding')
  assert.deepEqual(p.chain, [DSV41, QWEN, GEMMA]) // the smart lane never runs glm-5.3
  const img = [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]
  const v = planRoute({ model: 'jell0', messages: img }, {}, BEFORE)
  assert.equal(v.lane, 'vision')
  assert.deepEqual(v.chain, [DSV41, QWEN, GEMMA, SCOUT])
  const unknown = planRoute({ model: 'gpt-4o', messages: [{ role: 'user', content: 'debug code' }] }, {}, BEFORE)
  assert.equal(unknown.lane, 'coding')
})

test('routing: the X-Jell0-Preference header picks the lane when it names one', () => {
  const body = { model: 'jell0-fast', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(planRoute(body, { preference: 'flagship' }, BEFORE).lane, 'flagship')
  assert.equal(planRoute(body, { preference: 'not-a-lane' }, BEFORE).lane, 'fast')
})

// ---------------------------------------------------------------- capability filtering

test('capabilities: tools, images, context size and retirement filter the chain', () => {
  assert.equal(fits({ tools: false, vision: true, context: 1e6 }, { tools: true }), false)
  assert.equal(fits({ tools: true, vision: false, context: 1e6 }, { vision: true }), false)
  assert.equal(fits({ tools: true, vision: true, context: 1000 }, { tokens: 1001 }), false)
  assert.equal(fits({ tools: true, vision: true, context: 1000, retires: '2026-01-01T00:00:00Z' }, {}, BEFORE), false)
  const flag = resolveTarget('jell0-flagship', BEFORE)
  assert.deepEqual(chainFor(flag, { vision: true }, BEFORE), [DSV41, QWEN])
  assert.deepEqual(chainFor(flag, { tools: true }, BEFORE), [GLM53, DSV41, QWEN])
  assert.deepEqual(chainFor(resolveTarget('jell0-long', BEFORE), { tokens: 500000 }, BEFORE), [DSV41, GLM53])
  assert.deepEqual(chainFor(resolveTarget('glm-5.3', BEFORE), { vision: true }, BEFORE), [DSV41, QWEN])
  // nothing in the fast lane holds 300k tokens: the cheapest big-context model
  // takes it, never glm-5.3
  assert.deepEqual(chainFor(resolveTarget('jell0-fast', BEFORE), { tokens: 300000 }, BEFORE), [DSV41])
  assert.deepEqual(chainFor(flag, { tokens: 2000000 }, BEFORE), [])
})

test('capabilities: image bytes do not count as prompt text', () => {
  const big = 'A'.repeat(2000000)
  const n = estimateTokens({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + big } }] }] })
  assert.ok(n < 5000, String(n))
  assert.ok(estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }) >= 1000)
})

test('capabilities: a prompt too big for every model is an honest 400', async () => {
  const { env, aiCalls } = makeEnv()
  const r = await chat(env, bearer(KV_KEY), { model: 'jell0-long', messages: [{ role: 'user', content: 'x'.repeat(4400000) }] })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error.code, 'no_model_fits')
  assert.equal(aiCalls.length, 0)
})

// ---------------------------------------------------------------- runner

async function readAll(res) {
  return new Response(res.body).text()
}

function sseObjects(text) {
  return text.split('\n\n').filter(Boolean).map(e => e.replace(/^data: /, '')).map(d => (d === '[DONE]' ? d : JSON.parse(d)))
}

test('runner: Chat Completions JSON reply is normalized, model = catalog id', async () => {
  const { env } = makeEnv({
    ai: () => ({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'think', tool_calls: [{ function: { name: 'read', arguments: { path: 'a' } } }] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 } },
    }),
  })
  const r = await runChain(env, { messages: [{ role: 'user', content: 'x' }] }, { chain: [GLM53, DSV41], lane: 'flagship' })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('X-Jell0-Routed'), 'workersai/' + GLM53)
  assert.equal(r.headers.get('X-Jell0-Lane'), 'flagship')
  const j = await r.json()
  assert.match(j.id, /^chatcmpl-/)
  assert.equal(j.object, 'chat.completion')
  assert.equal(j.model, GLM53)
  assert.equal(typeof j.created, 'number')
  const c = j.choices[0]
  assert.equal(c.finish_reason, 'tool_calls')
  assert.equal(c.message.reasoning_content, 'think')
  assert.match(c.message.tool_calls[0].id, /^call_/)
  assert.equal(c.message.tool_calls[0].type, 'function')
  assert.equal(c.message.tool_calls[0].function.arguments, '{"path":"a"}')
  assert.equal(j.usage.total_tokens, 13)
  assert.equal(j.usage.prompt_tokens_details.cached_tokens, 2)
})

test('runner: older { response, tool_calls } reply becomes OpenAI JSON', async () => {
  const { env } = makeEnv({ ai: () => ({ response: '', tool_calls: [{ name: 'get_weather', arguments: { city: 'Paris' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) })
  const j = await (await runChain(env, { messages: [{ role: 'user', content: 'x' }] }, { chain: [SCOUT], lane: 'vision' })).json()
  const m = j.choices[0].message
  assert.equal(m.content, null)
  assert.equal(m.tool_calls[0].function.name, 'get_weather')
  assert.equal(m.tool_calls[0].function.arguments, '{"city":"Paris"}')
  assert.match(m.tool_calls[0].id, /^call_/)
  assert.equal(j.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(j.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })
  const { env: env2 } = makeEnv({ ai: () => ({ response: 'plain text' }) })
  const j2 = await (await runChain(env2, { messages: [] }, { chain: [SCOUT] })).json()
  assert.equal(j2.choices[0].message.content, 'plain text')
  assert.equal(j2.choices[0].finish_reason, 'stop')
})

test('runner: OpenAI-shaped stream passes through normalized, with tool call ids and [DONE]', async () => {
  const up = sseStream([
    data({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'hm' } }] }),
    data({ choices: [{ index: 0, delta: { content: 'Hel' } }] }),
    data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'ls', arguments: '{"a"' } }] } }] }),
    data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }),
    data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    data({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
    data('[DONE]'),
  ])
  const { env } = makeEnv({ ai: () => up })
  const r = await runChain(env, { messages: [] }, { stream: true, chain: [QWEN], lane: 'general' })
  assert.match(r.headers.get('content-type'), /text\/event-stream/)
  const evs = sseObjects(await readAll(r))
  assert.equal(evs.at(-1), '[DONE]')
  const objs = evs.slice(0, -1)
  for (const o of objs) {
    assert.equal(o.model, QWEN)
    assert.equal(o.object, 'chat.completion.chunk')
    assert.equal(o.id, objs[0].id)
  }
  const tc = objs.flatMap(o => o.choices.flatMap(c => c.delta.tool_calls || []))
  assert.match(tc[0].id, /^call_/)
  assert.equal(tc[1].id, undefined)
  assert.equal(objs.find(o => o.choices[0] && o.choices[0].finish_reason).choices[0].finish_reason, 'tool_calls')
  assert.equal(objs.at(-1).usage.total_tokens, 3)
})

test('runner: older { response } stream becomes OpenAI SSE with a finish chunk and usage', async () => {
  const up = sseStream([data({ response: 'Hel' }), data({ response: 'lo' }), data({ response: '', usage: { prompt_tokens: 4, completion_tokens: 2 } }), data('[DONE]')])
  const { env } = makeEnv({ ai: () => up })
  const r = await runChain(env, { messages: [] }, { stream: true, chain: [GEMMA], lane: 'fast' })
  const evs = sseObjects(await readAll(r))
  assert.equal(evs.at(-1), '[DONE]')
  const objs = evs.slice(0, -1)
  assert.equal(objs[0].choices[0].delta.role, 'assistant')
  assert.equal(objs.map(o => o.choices[0].delta.content || '').join(''), 'Hello')
  const last = objs.at(-1)
  assert.equal(last.choices[0].finish_reason, 'stop')
  assert.equal(last.usage.total_tokens, 6)
  for (const o of objs) assert.equal(o.model, GEMMA)
})

test('runner: a stream that never sends [DONE] still ends properly', async () => {
  const { env } = makeEnv({ ai: () => sseStream([data({ response: 'a' })]) })
  const evs = sseObjects(await readAll(await runChain(env, { messages: [] }, { stream: true, chain: [GEMMA] })))
  assert.equal(evs.at(-1), '[DONE]')
  assert.equal(evs.at(-2).choices[0].finish_reason, 'stop')
})

test('runner: streaming is real passthrough (first chunk arrives before upstream ends)', async () => {
  const up = sseStream([data({ response: 'first' })], { hold: true })
  const { env } = makeEnv({ ai: () => up })
  const r = await runChain(env, { messages: [] }, { stream: true, chain: [GEMMA] })
  const reader = r.body.getReader()
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('buffered: no chunk before upstream end')), 1000))
  const { value } = await Promise.race([reader.read(), timeout])
  assert.match(new TextDecoder().decode(value), /first/)
  up.push(data({ response: ' second' }))
  up.finish()
  let rest = ''
  for (;;) {
    const { value: v, done } = await reader.read()
    if (done) break
    rest += new TextDecoder().decode(v)
  }
  assert.match(rest, /second/)
  assert.match(rest, /\[DONE\]/)
})

test('runner: falls back on a thrown error, then on an error answer', async () => {
  const { env, aiCalls } = makeEnv({
    ai: (id) => {
      if (id === GLM53) throw new Error('3040: Capacity temporarily exceeded')
      if (id === DSV41) return { success: false, errors: [{ code: 5028, message: 'model gone' }] }
      return okJSON('from qwen')
    },
  })
  const r = await runChain(env, { messages: [] }, { chain: [GLM53, DSV41, QWEN], lane: 'flagship' })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('X-Jell0-Routed'), 'workersai/' + QWEN + ' (fallback)')
  assert.equal((await r.json()).choices[0].message.content, 'from qwen')
  assert.deepEqual(aiCalls.map(c => c.id), [GLM53, DSV41, QWEN])
})

test('runner: a stream whose first event is an error falls back to the next model', async () => {
  const { env } = makeEnv({
    ai: (id) => (id === GLM53 ? sseStream([data({ error: { message: 'rate limited', code: 429 } })]) : sseStream([data({ response: 'ok' }), data('[DONE]')])),
  })
  const r = await runChain(env, { messages: [] }, { stream: true, chain: [GLM53, GEMMA], lane: 'x' })
  assert.equal(r.headers.get('X-Jell0-Routed'), 'workersai/' + GEMMA + ' (fallback)')
  assert.match(await readAll(r), /"content":"ok"/)
})

test('runner: an error mid-stream becomes an OpenAI error event, then the stream ends', async () => {
  const { env } = makeEnv({ ai: () => sseStream([data({ response: 'a' }), data({ error: 'boom' }), data({ response: 'never' })]) })
  const text = await readAll(await runChain(env, { messages: [] }, { stream: true, chain: [GEMMA] }))
  assert.match(text, /"error":\{"message":"boom","type":"server_error"/)
  assert.ok(!text.includes('never'))
})

test('runner: when every model fails it answers an honest 503, never a made-up reply', async () => {
  const { env } = makeEnv({ ai: () => { throw new Error('5xx upstream') } })
  const r = await runChain(env, { messages: [] }, { chain: [GLM53, DSV41], lane: 'flagship' })
  assert.equal(r.status, 503)
  const j = await r.json()
  assert.equal(j.error.type, 'server_error')
  assert.equal(j.error.code, 'all_models_failed')
  assert.match(j.error.message, /glm-5\.3: 5xx upstream/)
  assert.equal(j.choices, undefined)
  assert.ok(!JSON.stringify(j).includes('flatline'))
  const { env: env2 } = makeEnv({ ai: () => { throw new Error('down') } })
  const viaRoute = await chat(env2, bearer(KV_KEY))
  assert.equal(viaRoute.status, 503)
})

test('runner: fields Workers AI does not take are dropped; reasoning is mapped per model', () => {
  const glm = MODELS.find(m => m.id === GLM53)
  const gemma = MODELS.find(m => m.id === GEMMA)
  const scout = MODELS.find(m => m.id === SCOUT)
  const body = {
    model: 'x', provider: 'openrouter', reasoning_details: [1], parallel_tool_calls: false, stream_options: { include_usage: true },
    messages: [{ role: 'assistant', content: null, reasoning_details: [1], tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }], tool_choice: 'auto', temperature: 0.2, top_p: 0.9, stop: ['x'],
    response_format: { type: 'json_object' }, reasoning_effort: 'medium',
  }
  const i = buildInput(glm, body, true)
  for (const k of ['model', 'provider', 'reasoning_details']) assert.equal(i[k], undefined, k)
  // glm-5.3 has a Chat Completions schema: it takes parallel_tool_calls, and a
  // stream asks for usage; llama-4-scout does not get either
  assert.equal(i.parallel_tool_calls, false)
  assert.deepEqual(i.stream_options, { include_usage: true })
  const s = buildInput(scout, body, true)
  assert.equal(s.parallel_tool_calls, undefined)
  assert.equal(s.stream_options, undefined)
  assert.equal(i.stream, true)
  assert.equal(i.reasoning_effort, 'high') // medium -> nearest glm-5.3 level
  assert.deepEqual(Object.keys(i.messages[0]).sort(), ['content', 'role', 'tool_calls'])
  assert.equal(i.messages[0].content, '')
  assert.equal(i.messages[1].content[0].cache_control, undefined)
  for (const k of ['tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'response_format']) assert.deepEqual(i[k], body[k], k)
  assert.equal(buildInput(scout, body).reasoning_effort, undefined)
  assert.deepEqual(buildInput(gemma, body).chat_template_kwargs, { enable_thinking: true })
  assert.deepEqual(buildInput(gemma, { messages: [], reasoning_effort: 'none' }).chat_template_kwargs, { enable_thinking: false })
  assert.equal(buildInput(glm, { messages: [], thinking: { type: 'enabled', budget_tokens: 1000 } }).reasoning_effort, 'high')
  assert.equal(buildInput(glm, { messages: [] }).reasoning_effort, undefined)
  const noTools = buildInput(glm, { messages: [], tools: [], tool_choice: 'auto' })
  assert.equal(noTools.tools, undefined)
  assert.equal(noTools.tool_choice, undefined)
  assert.equal(nearestEffort('xhigh', ['low', 'high', 'max']), 'max')
  assert.equal(nearestEffort('none', ['low', 'high', 'max']), 'low')
  assert.equal(nearestEffort('weird', ['low']), undefined)
})

// ---------------------------------------------------------------- max_tokens cap

test('max_tokens is capped per model; a default is set when absent', async () => {
  const glm = MODELS.find(m => m.id === GLM53)
  assert.equal(MAX_TOKENS_CAP, 32768)
  assert.equal(buildInput(glm, { messages: [], max_tokens: 1e9 }).max_tokens, 32768)
  assert.equal(buildInput(glm, { messages: [], max_tokens: 500 }).max_tokens, 500)
  assert.equal(buildInput(glm, { messages: [] }).max_tokens, DEFAULT_MAX_TOKENS)
  assert.equal(buildInput(glm, { messages: [], max_tokens: 'lots' }).max_tokens, DEFAULT_MAX_TOKENS)
  const mc = buildInput(glm, { messages: [], max_completion_tokens: 99999999 })
  assert.equal(mc.max_completion_tokens, 32768)
  assert.equal(mc.max_tokens, undefined)
  for (const m of MODELS) assert.ok(m.maxOutput <= MAX_TOKENS_CAP, m.id)
  const { env, aiCalls } = makeEnv()
  await chat(env, bearer(KV_KEY), { ...CHAT, max_tokens: 5000000 })
  assert.equal(aiCalls[0].input.max_tokens, 32768)
  await worker.fetch(req('/v1/messages', { method: 'POST', body: { ...MSG, max_tokens: 9000000 }, headers: bearer(KV_KEY) }), env)
  assert.equal(aiCalls[1].input.max_tokens, 32768)
})

// ---------------------------------------------------------------- endpoints end to end

test('endpoints: /v1/models and /models list lanes and catalog models', async () => {
  const { env } = makeEnv()
  for (const path of ['/v1/models', '/models']) {
    const j = await (await worker.fetch(req(path), env)).json()
    assert.equal(j.object, 'list')
    const ids = j.data.map(m => m.id)
    for (const id of ['jell0', 'jell0-flagship', 'jell0-max', 'jell0-glm', 'jell0-fast', 'glm-5.3', GLM53, 'deepseek-v4.1-flash', 'qwen3.8-27b']) assert.ok(ids.includes(id), id)
  }
})

test('endpoints: /select shows the chain without calling a model', async () => {
  const { env, aiCalls } = makeEnv()
  const j = await (await worker.fetch(req('/select?prompt=' + encodeURIComponent('refactor this typescript class') + '&pref=smart'), env)).json()
  assert.equal(j.category, 'coding')
  assert.equal(j.pick, DSV41)
  assert.deepEqual(j.chain, [DSV41, QWEN, GEMMA])
  const f = await (await worker.fetch(req('/select?pref=jell0-fast'), env)).json()
  assert.equal(f.pick, GEMMA)
  assert.equal(aiCalls.length, 0)
})

test('endpoints: OpenAI chat routes to Workers AI, with routing headers', async () => {
  const { env, aiCalls } = makeEnv()
  for (const path of ['/v1/chat/completions', '/chat/completions']) {
    const r = await worker.fetch(req(path, { method: 'POST', body: { ...CHAT, model: 'glm-5.3' }, headers: bearer(KV_KEY) }), env)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('X-Jell0-Routed'), 'workersai/' + GLM53)
    assert.equal(r.headers.get('X-Jell0-Lane'), 'flagship')
  }
  assert.equal(aiCalls[0].id, GLM53)
  const bad = await worker.fetch(req('/v1/chat/completions', { method: 'POST', body: '{not json', headers: bearer(KV_KEY) }), env)
  assert.equal(bad.status, 400)
  const empty = await chat(env, bearer(KV_KEY), { model: 'jell0' })
  assert.equal(empty.status, 400)
})

test('endpoints: /v1/messages (JSON) maps claude-opus to the flagship lane and answers Anthropic JSON', async () => {
  const { env, aiCalls } = makeEnv({ ai: () => okJSON('hi from glm') })
  const r = await worker.fetch(req('/v1/messages', { method: 'POST', body: MSG, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 200)
  assert.equal(aiCalls[0].id, GLM53)
  assert.equal(r.headers.get('X-Jell0-Lane'), 'flagship')
  const j = await r.json()
  assert.equal(j.type, 'message')
  assert.equal(j.model, 'claude-opus-4-1')
  assert.equal(j.content[0].text, 'hi from glm')
  const hk = await worker.fetch(req('/v1/messages', { method: 'POST', body: { ...MSG, model: 'claude-haiku-4-5' }, headers: { 'x-api-key': KV_KEY } }), env)
  assert.equal(hk.status, 200)
  assert.equal(aiCalls[1].id, GEMMA)
})

test('endpoints: /v1/messages streaming answers Anthropic SSE', async () => {
  const { env } = makeEnv({ ai: () => sseStream([data({ response: 'Hel' }), data({ response: 'lo' }), data('[DONE]')]) })
  const r = await worker.fetch(req('/v1/messages', { method: 'POST', body: { ...MSG, stream: true }, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/event-stream/)
  const text = await readAll(r)
  for (const ev of ['message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'message_stop']) assert.match(text, new RegExp('event: ' + ev))
  assert.match(text, /"text":"Hel"/)
})

test('endpoints: /v1/messages when every model fails is a 503 Anthropic error', async () => {
  const { env } = makeEnv({ ai: () => { throw new Error('busy') } })
  const r = await worker.fetch(req('/v1/messages', { method: 'POST', body: MSG, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 503)
  const j = await r.json()
  assert.equal(j.type, 'error')
  assert.match(j.error.message, /busy/)
})

test('endpoints: count_tokens answers input_tokens with a key', async () => {
  const { env, aiCalls } = makeEnv()
  const r = await worker.fetch(req('/v1/messages/count_tokens', { method: 'POST', body: MSG, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 200)
  assert.ok((await r.json()).input_tokens > 0)
  assert.equal(aiCalls.length, 0)
})

// ---------------------------------------------------------------- no provider secrets

test('env: jell0 reads only AI, JELL0_CONFIG, MGR_DB, the two rate limiters and JELL0_ADMIN_TOKEN (its only secret)', async () => {
  clearKeyCache()
  const { env } = makeEnv() // strict proxy: any other env key throws, which would surface as a 500
  const calls = [
    req('/'), req('/health'), req('/v1/models'), req('/select?prompt=hi'),
    req('/v1/chat/completions', { method: 'POST', body: CHAT, headers: bearer(KV_KEY) }),
    req('/v1/chat/completions', { method: 'POST', body: { ...CHAT, stream: true }, headers: bearer(MGR_OK) }),
    req('/v1/chat/completions', { method: 'POST', body: CHAT, headers: bearer('nobody') }),
    req('/v1/messages', { method: 'POST', body: MSG, headers: bearer(KV_KEY) }),
    req('/v1/messages', { method: 'POST', body: { ...MSG, stream: true }, headers: bearer(KV_KEY) }),
    req('/v1/messages/count_tokens', { method: 'POST', body: MSG, headers: bearer(KV_KEY) }),
    req('/api/jell0/keys', { headers: bearer(ADMIN) }),
    req('/api/jell0/keys', { method: 'POST', body: { label: 'x' }, headers: bearer(ADMIN) }),
    req('/api/jell0/session', { headers: bearer(ADMIN) }),
  ]
  for (const r of calls) {
    const res = await worker.fetch(r, env)
    assert.notEqual(res.status, 500, r.method + ' ' + new URL(r.url).pathname)
    await res.arrayBuffer()
  }
  // and statically: no env.X in the source other than these bindings
  for (const f of ['index.js', 'catalog.js', 'workersai.js', 'keys.js']) {
    const src = readFileSync(join(JELL0, 'src', f), 'utf8')
    for (const m of src.matchAll(/env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      assert.ok(['AI', 'JELL0_CONFIG', 'MGR_DB', 'JELL0_ADMIN_TOKEN', 'JELL0_IP_LIMIT', 'JELL0_KEY_LIMIT'].includes(m[1]), f + ' reads env.' + m[1])
    }
    assert.ok(!/env\[/.test(src), f + ' reads env by computed key')
    assert.ok(!/\bfetch\(/.test(src.replace(/async fetch\(request, env\)/, '')), f + ' calls fetch (no outside provider allowed)')
  }
})

// ---------------------------------------------------------------- files: secrets, dashes, routes

function filesUnder(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.wrangler')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const OUR_FILES = () => [...filesUnder(JELL0), join(REPO, '.github', 'workflows', 'jell0-deploy.yml')].filter(existsSync)

test('files: no literal secret from the old bundle in any jell0 file (compared by SHA-256)', t => {
  const sec = bundleSecrets()
  if (!sec || !sec.password || !sec.bearer) return t.skip('old bundle not present')
  const plain = new Set([sec.password, sec.hmacFallback].filter(Boolean).map(h))
  const bearerHash = h(sec.bearer)
  for (const f of OUR_FILES()) {
    const text = readFileSync(f, 'utf8')
    const name = relative(REPO, f)
    // 1. no string literal equal to the old admin password or HMAC fallback
    for (const m of text.matchAll(LITERAL)) assert.ok(!plain.has(h(m[2])), name + ' holds a literal secret from the old bundle')
    // 2. the old admin password appears nowhere, not even in prose
    if (sec.password.length >= 5) assert.ok(!text.includes(sec.password), name + ' contains the old admin password')
    // 3. the old shared bearer must never be compared as a credential in
    //    plain text (it is not accepted at all any more)
    const compared = [
      ...text.matchAll(/(?:===|!==|==|!=)\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g),
      ...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1\s*(?:===|!==|==|!=)/g),
      ...text.matchAll(/case\s+(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g),
    ]
    for (const m of compared) assert.ok(h(m[2]) !== bearerHash, name + ' compares a value against the legacy bearer in plain text')
  }
})

test('files: phase A is gone: no jell0 file holds the old bearer hash, and no legacy key code is left', async () => {
  const sec = bundleSecrets()
  if (sec && sec.bearer) {
    const bad = new Set([h(sec.bearer), h(h(sec.bearer))])
    for (const f of OUR_FILES()) {
      const text = readFileSync(f, 'utf8').toLowerCase()
      for (const run of text.match(/[0-9a-f]{64,}/g) || []) {
        for (let i = 0; i + 64 <= run.length; i++) assert.ok(!bad.has(run.slice(i, i + 64)), relative(REPO, f) + ' still holds a hash of the old bearer')
      }
    }
  }
  assert.deepEqual(Object.keys(keys).filter(k => /legacy/i.test(k)), [], 'keys.js still exports legacy helpers')
  for (const f of ['index.js', 'catalog.js', 'workersai.js', 'keys.js', 'anthropic.js']) {
    const src = readFileSync(join(JELL0, 'src', f), 'utf8')
    assert.ok(!/legacy|lockLane|limitsFor/i.test(src), f + ' still has legacy key code')
  }
})

test('files: no em or en dashes; wrangler.toml has no routes and keeps workers.dev', () => {
  for (const f of OUR_FILES()) {
    assert.ok(!DASHES.test(readFileSync(f, 'utf8')), relative(REPO, f) + ' has an em or en dash')
  }
  const toml = readFileSync(join(JELL0, 'wrangler.toml'), 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  assert.ok(!/^\s*routes?\s*=|\[\[?routes\]\]?|custom_domain/m.test(toml), 'wrangler.toml must not add routes or custom domains')
  assert.match(toml, /^name = "jell0-router"$/m)
  assert.match(toml, /^main = "src\/index\.js"$/m)
  assert.match(toml, /^workers_dev = true$/m)
  assert.match(toml, /^keep_vars = true$/m)
  assert.match(toml, /binding = "AI"/)
  assert.match(toml, /binding = "JELL0_CONFIG"/)
  assert.match(toml, /binding = "MGR_DB"/)
})
