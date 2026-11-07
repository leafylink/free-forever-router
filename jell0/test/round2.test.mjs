// Round 2 review fixes, one test (or a few) per finding id. Fake bindings only:
// a KV with list/delete and metadata, an AI mock that records every argument,
// a D1 mock, and rate limiter mocks. No network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import worker from '../src/index.js'
import { MODELS, LANES, planRoute, classify, resolveTarget, chainFor } from '../src/catalog.js'
import { runChain, buildInput, errorKind } from '../src/workersai.js'
import { anthropicToOpenAI } from '../src/anthropic.js'
import { clearKeyCache } from '../src/keys.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const JELL0 = join(HERE, '..')
const REPO = join(JELL0, '..')
const README = () => readFileSync(join(JELL0, 'README.md'), 'utf8')
const TOML = () => readFileSync(join(JELL0, 'wrangler.toml'), 'utf8')
const WORKFLOW = join(REPO, '.github', 'workflows', 'jell0-deploy.yml')

const GLM53 = '@cf/zai-org/glm-5.3'
const GLM52 = '@cf/zai-org/glm-5.2'
const DSV41 = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
const QWEN = '@cf/qwen/qwen3.8-27b'
const GEMMA = '@cf/google/gemma-4-26b-a4b-it'
const OSS20 = '@cf/openai/gpt-oss-20b'
const NOW = Date.parse('2026-11-10T00:00:00Z')
const model = id => MODELS.find(m => m.id === id)

const h = s => createHash('sha256').update(s).digest('hex')
const ADMIN = 'jell0-admin-v2.' + h('round two admin token')
const KV_KEY = 'jell0-' + h('round two kv key').slice(0, 48)
const mgr = s => 'llk_' + h('round two manager ' + s)
const MGR_AI = mgr('ai only')
const MGR_ADMIN_AI = mgr('admin and ai')
const MGR_PROD_AI = mgr('production and ai')

// ---------------------------------------------------------------- fakes

function fakeKV({ delay = 0 } = {}) {
  const store = new Map() // name -> { value, metadata }
  const wait = () => (delay ? new Promise(r => setTimeout(r, delay)) : undefined)
  return {
    store,
    gets: [],
    async get(k) { this.gets.push(k); const v = store.has(k) ? store.get(k).value : null; await wait(); return v },
    async put(k, value, opts = {}) { store.set(k, { value, metadata: opts.metadata ?? null }) },
    async delete(k) { store.delete(k) },
    async list({ prefix = '' } = {}) {
      await wait()
      const keys = [...store.keys()].filter(n => n.startsWith(prefix)).sort().map(name => ({ name, metadata: store.get(name).metadata }))
      return { keys, list_complete: true }
    },
  }
}

function fakeLimiter(limit) {
  const counts = new Map()
  const keys = []
  return { keys, async limit({ key }) { keys.push(key); const n = (counts.get(key) || 0) + 1; counts.set(key, n); return { success: n <= limit } } }
}

function okJSON(text = 'hello') {
  return { choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }
}

function makeEnv({ ai, adminToken = ADMIN, rows, kv, ipLimit, keyLimit } = {}) {
  const KV = kv || fakeKV()
  const meta = { id: 'k1', label: 'opencode', hint: KV_KEY.slice(-4), created: '2026-11-07T00:00:00.000Z' }
  KV.store.set('key:' + h(KV_KEY), { value: JSON.stringify(meta), metadata: meta })
  const aiCalls = []
  const sqls = []
  const table = rows ?? [
    { hash: h(MGR_AI), perms: 'ai_models' },
    { hash: h(MGR_ADMIN_AI), perms: 'admin,ai_models' },
    { hash: h(MGR_PROD_AI), perms: 'ai_models,production' },
  ]
  const env = {
    AI: {
      async run(...args) {
        const [id, input] = args
        aiCalls.push({ id, input: structuredClone(input), args: args.length, options: args[2] })
        return ai ? ai(id, input, aiCalls.length) : okJSON()
      },
    },
    JELL0_CONFIG: KV,
    MGR_DB: {
      prepare(sql) {
        sqls.push(sql)
        return { bind(hash) { return { async first() { return table.find(r => r.hash === hash) || null } } } }
      },
    },
  }
  if (adminToken !== undefined) env.JELL0_ADMIN_TOKEN = adminToken
  if (ipLimit) env.JELL0_IP_LIMIT = ipLimit
  if (keyLimit) env.JELL0_KEY_LIMIT = keyLimit
  return { env, aiCalls, sqls, kv: KV }
}

const req = (path, { method = 'POST', body, headers = {} } = {}) => new Request('https://jell0.example.workers.dev' + path, {
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const bearer = k => ({ Authorization: 'Bearer ' + k })
const CHAT = { model: 'jell0-flagship', messages: [{ role: 'user', content: 'hello there' }] }
const MSG = { model: 'claude-opus-4-1', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }
const bigText = tokens => 'x '.repeat(tokens * 2) // about `tokens` tokens at 4 characters each

// ---------------------------------------------------------------- SEC-R2-1

test('SEC-R2-1: an admin token without the jell0-admin-v2 format is 401 on every admin route', async () => {
  const leftover = 'old-shared-admin-token-' + 'q'.repeat(23) // 46 characters, like the old one
  for (const adminToken of [leftover, 'jell0-admin-v2.too-short', 'jell0-admin-v2.' + 'a'.repeat(39), ' ' + ADMIN]) {
    const { env, kv } = makeEnv({ adminToken })
    const calls = [
      req('/api/jell0/keys', { method: 'GET', headers: bearer(adminToken) }),
      req('/api/jell0/keys', { body: { label: 'x' }, headers: bearer(adminToken) }),
      req('/api/jell0/keys?id=k1', { method: 'DELETE', headers: bearer(adminToken) }),
      req('/api/jell0/session', { method: 'GET', headers: bearer(adminToken) }),
    ]
    for (const r of calls) assert.equal((await worker.fetch(r, env)).status, 401, adminToken.length + ' ' + r.method + ' ' + new URL(r.url).pathname)
    assert.ok(kv.store.has('key:' + h(KV_KEY)), 'nothing was deleted')
    assert.equal([...kv.store.keys()].length, 1, 'nothing was minted')
  }
  // GET /api/jell0/session says why admin is off, without echoing the token
  const { env } = makeEnv({ adminToken: leftover })
  const s = await (await worker.fetch(req('/api/jell0/session', { method: 'GET' }), env)).text()
  assert.match(s, /jell0-admin-v2\./)
  assert.ok(!s.includes(leftover))
  const none = await (await worker.fetch(req('/api/jell0/session', { method: 'GET' }), makeEnv({ adminToken: '' }).env)).text()
  assert.match(none, /not set/)
})

test('SEC-R2-1: a v2 admin token works; README, wrangler.toml and the workflow say how to make one', async t => {
  const { env } = makeEnv()
  assert.equal((await worker.fetch(req('/api/jell0/session', { method: 'GET', headers: bearer(ADMIN) }), env)).status, 200)
  const made = await worker.fetch(req('/api/jell0/keys', { body: { label: 'box' }, headers: bearer(ADMIN) }), env)
  assert.equal(made.status, 200)
  const step2 = README().slice(README().indexOf('2. **Set a fresh'))
  assert.match(step2.slice(0, 900), /jell0-admin-v2\./)
  assert.match(step2.slice(0, 900), /openssl rand -hex 32/)
  assert.match(TOML(), /jell0-admin-v2\./)
  assert.match(readFileSync(WORKFLOW, 'utf8'), /jell0-admin-v2\./)
  // the old bundle (when present) holds no string that could pass the v2 format
  if (!existsSync(BUNDLE)) return t.skip('old bundle not present')
  for (const m of readFileSync(BUNDLE, 'utf8').matchAll(LITERAL)) assert.ok(!m[2].startsWith('jell0-admin-v2.'))
})

// ---------------------------------------------------------------- COST-R2-1

test('COST-R2-1: a prompt over the cap is a 400 prompt_too_large before any model call', async () => {
  const { env, aiCalls } = makeEnv()
  const big = { role: 'user', content: bigText(250000) }
  const o = await worker.fetch(req('/v1/chat/completions', { body: { model: 'jell0-flagship', messages: [big] }, headers: bearer(KV_KEY) }), env)
  assert.equal(o.status, 400)
  const oj = await o.json()
  assert.equal(oj.error.code, 'prompt_too_large')
  assert.match(oj.error.message, /^prompt is too long: \d+ tokens > 200000 maximum/)
  for (const name of ['glm-5.3', 'deepseek', 'jell0', 'jell0-fast', 'qwen']) {
    const r = await worker.fetch(req('/v1/chat/completions', { body: { model: name, messages: [big] }, headers: bearer(KV_KEY) }), env)
    assert.equal(r.status, 400, name)
  }
  const a = await worker.fetch(req('/v1/messages', { body: { ...MSG, messages: [big] }, headers: bearer(KV_KEY) }), env)
  assert.equal(a.status, 400)
  const aj = await a.json()
  assert.equal(aj.error.type, 'invalid_request_error')
  assert.match(aj.error.message, /^prompt is too long/)
  assert.equal(aiCalls.length, 0)
  // the long lane, named on purpose, still takes it (DeepSeek first)
  const l = await worker.fetch(req('/v1/chat/completions', { body: { model: 'jell0-long', messages: [big] }, headers: bearer(KV_KEY) }), env)
  assert.equal(l.status, 200)
  assert.equal(aiCalls[0].id, DSV41)
})

test('COST-R2-1: request N+1 in a minute on one key is a 429; the limiter never sees the key itself', async () => {
  const keyLimit = fakeLimiter(3)
  const { env, aiCalls } = makeEnv({ keyLimit })
  for (let i = 0; i < 3; i++) assert.equal((await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(KV_KEY) }), env)).status, 200)
  const o = await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(KV_KEY) }), env)
  assert.equal(o.status, 429)
  assert.equal((await o.json()).error.code, 'rate_limit_exceeded')
  assert.ok(Number(o.headers.get('retry-after')) > 0)
  const a = await worker.fetch(req('/v1/messages', { body: MSG, headers: { 'x-api-key': KV_KEY } }), env)
  assert.equal(a.status, 429)
  assert.equal((await a.json()).error.type, 'rate_limit_error')
  assert.equal(aiCalls.length, 3)
  assert.ok(keyLimit.keys.every(k => k === 'key:' + h(KV_KEY)), 'keyed by the SHA-256 of the key')
  // the bindings are declared, 60 s windows
  const toml = TOML()
  for (const name of ['JELL0_KEY_LIMIT', 'JELL0_IP_LIMIT']) assert.match(toml, new RegExp('\\[\\[ratelimits\\]\\]\\nname = "' + name + '"\\nnamespace_id = "\\d+"\\n\\n  \\[ratelimits\\.simple\\]\\n  limit = \\d+\\n  period = 60'))
  assert.match(README(), /input/i)
  assert.match(README(), /200,000/)
})

// ---------------------------------------------------------------- SEC-R2-2

test('SEC-R2-2: each KV key is its own entry; overlapping admin calls never bring a deleted key back', async () => {
  const kv = fakeKV({ delay: 20 })
  const { env } = makeEnv({ kv })
  const LEAKED = 'jell0-' + h('leaked').slice(0, 48)
  const meta = { id: 'leaked', label: 'leaked', hint: LEAKED.slice(-4), created: '2026-11-07T00:00:00.000Z' }
  kv.store.set('key:' + h(LEAKED), { value: JSON.stringify(meta), metadata: meta })
  const use = k => worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(k) }), env)
  assert.equal((await use(LEAKED)).status, 200)
  const [del, made] = await Promise.all([
    worker.fetch(req('/api/jell0/keys?id=leaked', { method: 'DELETE', headers: bearer(ADMIN) }), env),
    worker.fetch(req('/api/jell0/keys', { body: { label: 'box' }, headers: bearer(ADMIN) }), env),
  ])
  assert.equal((await del.json()).removed, 1)
  const box = await made.json()
  assert.equal((await use(LEAKED)).status, 401, 'the deleted key stays deleted')
  assert.equal((await use(box.key)).status, 200, 'the new key is kept')
  assert.ok(kv.store.has('key:' + h(box.key)))
  assert.equal(kv.store.has('api_keys'), false, 'nothing writes the old shared list')
  // auth is one KV read of that key's own entry
  kv.gets.length = 0
  await use(box.key)
  assert.deepEqual(kv.gets, ['key:' + h(box.key)])
})

test('SEC-R2-2: entries in the old api_keys list are never keys, stay listed, and can be deleted', async () => {
  const { env, kv } = makeEnv()
  const OLD = 'old-plain-key-' + 'z'.repeat(20)
  kv.store.set('api_keys', { value: JSON.stringify([{ id: 'p1', label: 'old', key: OLD }, { id: 'p2', label: 'hashed', hash: h(OLD) }]), metadata: null })
  assert.equal((await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(OLD) }), env)).status, 401)
  const list = await (await worker.fetch(req('/api/jell0/keys', { method: 'GET', headers: bearer(ADMIN) }), env)).json()
  assert.deepEqual(list.keys.map(k => k.id).sort(), ['k1', 'p1', 'p2'])
  assert.match(list.keys.find(k => k.id === 'p1').stored, /NOT accepted/)
  assert.equal(list.keys.find(k => k.id === 'k1').stored, 'sha256')
  assert.ok(!JSON.stringify(list).includes(OLD) && !JSON.stringify(list).includes(h(KV_KEY)))
  const d = await (await worker.fetch(req('/api/jell0/keys?id=p1', { method: 'DELETE', headers: bearer(ADMIN) }), env)).json()
  assert.equal(d.removed, 1)
  assert.deepEqual(JSON.parse(kv.store.get('api_keys').value).map(k => k.id), ['p2'])
})

// ---------------------------------------------------------------- SEC-R2-3

const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g
const BUNDLE = process.env.JELL0_BUNDLE || ''

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

test('SEC-R2-3: no jell0 file holds a hash (or a hash of a hash) of any string in the old bundle', t => {
  if (!existsSync(BUNDLE)) return t.skip('old bundle not present')
  const bundle = readFileSync(BUNDLE, 'utf8')
  const bad = new Set()
  for (const m of bundle.matchAll(LITERAL)) {
    if (m[2].length < 8) continue
    bad.add(h(m[2]))
    bad.add(h(h(m[2])))
  }
  // the old bearer is found from its place in the old auth code, not from a stored hash
  const bearer = /auth\.slice\(7\)\.trim\(\);[\s\S]{0,120}?key === (["'`])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(bundle)
  assert.ok(bearer, 'the old bearer is found in isAuthed')
  bad.add(h(bearer[2]))
  bad.add(h(h(bearer[2])))
  for (const f of [...filesUnder(JELL0), WORKFLOW].filter(existsSync)) {
    const text = readFileSync(f, 'utf8').toLowerCase()
    for (const run of text.match(/[0-9a-f]{64,}/g) || []) {
      for (let i = 0; i + 64 <= run.length; i++) assert.ok(!bad.has(run.slice(i, i + 64)), relative(REPO, f) + ' holds a hash of a string from the old bundle')
    }
  }
})

// ---------------------------------------------------------------- COST-R2-2

test('COST-R2-2: 502 unreadable_reply and 400 invalid_request tell clients not to retry', async () => {
  const shape = makeEnv({ ai: () => ({ something: 'else' }) })
  const r = await runChain(shape.env, { messages: [{ role: 'user', content: 'x' }] }, { chain: [GLM53, DSV41], lane: 'flagship' })
  assert.equal(r.status, 502)
  assert.equal(r.headers.get('x-should-retry'), 'false')
  for (const [path, body] of [['/v1/messages', MSG], ['/v1/chat/completions', CHAT]]) {
    const { env, aiCalls } = makeEnv({ ai: () => ({ something: 'else' }) })
    const res = await worker.fetch(req(path, { body, headers: bearer(KV_KEY) }), env)
    assert.equal(res.status, 502, path)
    assert.equal(res.headers.get('x-should-retry'), 'false', path)
    assert.equal(aiCalls.length, 1)
  }
  for (const [path, body] of [['/v1/messages', MSG], ['/v1/chat/completions', CHAT]]) {
    const { env } = makeEnv({ ai: () => { throw new Error('5004: Invalid data type for base64 input') } })
    const res = await worker.fetch(req(path, { body, headers: bearer(KV_KEY) }), env)
    assert.equal(res.status, 400, path)
    assert.equal(res.headers.get('x-should-retry'), 'false', path)
  }
  const rd = README()
  assert.match(rd, /x-should-retry: false/)
  assert.ok(!/one bad shape is never billed twice/.test(rd), 'README no longer promises no second bill')
})

// ---------------------------------------------------------------- OPS-R2-1

test('OPS-R2-1: the deploy job runs only from main', () => {
  const y = readFileSync(WORKFLOW, 'utf8')
  assert.match(y, /\n {2}deploy:\n {4}if: github\.ref == 'refs\/heads\/main'\n/)
})

// ---------------------------------------------------------------- SEC-R2-4

test('SEC-R2-4: a Manager key works only when AI models is its only permission', async () => {
  clearKeyCache()
  const { env } = makeEnv()
  const use = k => worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(k) }), env)
  assert.equal((await use(MGR_AI)).status, 200)
  assert.equal((await use(MGR_ADMIN_AI)).status, 401)
  assert.equal((await use(MGR_PROD_AI)).status, 401)
  clearKeyCache()
  const rd = README()
  assert.match(rd, /ONLY the \*\*AI models\*\* permission/)
  assert.ok(!/Manager key with the \*\*AI models\*\* permission/.test(rd))
})

// ---------------------------------------------------------------- SEC-R2-5

test('SEC-R2-5: callers are rate limited by IP before any KV or D1 lookup', async () => {
  clearKeyCache()
  const ipLimit = fakeLimiter(5)
  const { env, sqls, kv } = makeEnv({ ipLimit })
  const statuses = []
  for (let i = 0; i < 6; i++) {
    const r = await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: { ...bearer('llk_' + h('random ' + i)), 'CF-Connecting-IP': '203.0.113.9' } }), env)
    statuses.push(r.status)
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429])
  assert.equal(sqls.length, 5, 'the sixth caller caused no D1 query')
  const kvReads = kv.gets.length
  const m = await worker.fetch(req('/v1/messages', { body: MSG, headers: { 'x-api-key': 'llk_' + h('random 7'), 'CF-Connecting-IP': '203.0.113.9' } }), env)
  assert.equal(m.status, 429)
  assert.equal((await m.json()).error.type, 'rate_limit_error')
  assert.equal(kv.gets.length, kvReads, 'and no KV read')
  const other = await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: { ...bearer('llk_' + h('random 8')), 'CF-Connecting-IP': '198.51.100.1' } }), env)
  assert.equal(other.status, 401, 'another IP is not limited')
  clearKeyCache()
})

test('SEC-R2-5: the docs do not call the D1 binding read only', () => {
  for (const [name, text] of [['README.md', README()], ['wrangler.toml', TOML()]]) {
    assert.ok(!/read only|read-only/i.test(text), name)
    assert.match(text, /binding itself can write/, name)
  }
})

// ---------------------------------------------------------------- CP-1

const systemShape = msgs => msgs.map(m => m.role)

test('CP-1: OpenCode\'s two leading system messages reach the model as one', async () => {
  const { env, aiCalls } = makeEnv()
  const body = { model: 'qwen3.8-27b', messages: [{ role: 'system', content: 'You are opencode.' }, { role: 'system', content: 'Project rules.' }, { role: 'user', content: 'hi' }] }
  assert.equal((await worker.fetch(req('/v1/chat/completions', { body, headers: bearer(KV_KEY) }), env)).status, 200)
  assert.equal(aiCalls[0].id, QWEN)
  assert.deepEqual(aiCalls[0].input.messages, [{ role: 'system', content: 'You are opencode.\n\nProject rules.' }, { role: 'user', content: 'hi' }])
})

test('CP-1: Claude Code\'s mid-conversation system messages move into user turns as reminders', async () => {
  const { env, aiCalls } = makeEnv()
  const body = {
    model: 'glm-5.3', max_tokens: 100,
    system: [{ type: 'text', text: 'You are Claude Code.' }],
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'system', content: [{ type: 'text', text: 'File changed on disk.' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'next' }] },
      { role: 'assistant', content: 'done' },
      { role: 'system', content: 'Todo list is empty.' },
    ],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  }
  assert.equal((await worker.fetch(req('/v1/messages', { body, headers: bearer(KV_KEY) }), env)).status, 200)
  const sent = aiCalls[0].input.messages
  assert.deepEqual(systemShape(sent), ['system', 'user', 'assistant', 'tool', 'user', 'assistant', 'user'])
  assert.equal(sent[0].content, 'You are Claude Code.')
  assert.equal(sent[4].content, '<system-reminder>\nFile changed on disk.\n</system-reminder>\n\nnext')
  assert.equal(sent[6].content, '<system-reminder>\nTodo list is empty.\n</system-reminder>')
})

test('CP-1: no request reaching env.AI.run has two system messages or one after index 0', async () => {
  const shapes = [
    [{ role: 'system', content: 'a' }, { role: 'system', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: 'u' }, { role: 'system', content: 'c' }],
    [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }, { role: 'system', content: 'd' }, { role: 'user', content: [{ type: 'text', text: 'again' }] }],
    [{ role: 'assistant', content: 'x' }, { role: 'system', content: 'e' }],
    [{ role: 'system', content: '' }, { role: 'user', content: 'u' }],
  ]
  for (const messages of shapes) {
    const { env, aiCalls } = makeEnv()
    await worker.fetch(req('/v1/chat/completions', { body: { model: 'qwen', messages }, headers: bearer(KV_KEY) }), env)
    const sent = aiCalls[0].input.messages
    assert.ok(sent.filter(m => m.role === 'system').length <= 1, JSON.stringify(sent))
    assert.ok(sent.every((m, i) => m.role !== 'system' || i === 0), JSON.stringify(sent))
    // no system text is lost on the way
    const text = JSON.stringify(sent)
    for (const m of messages.filter(x => x.role === 'system')) {
      const t = typeof m.content === 'string' ? m.content : m.content.map(p => p.text).join('')
      if (t) assert.ok(text.includes(t), t)
    }
  }
  // an image turn keeps its image and gets the reminder as a text part
  const { env, aiCalls } = makeEnv()
  await worker.fetch(req('/v1/chat/completions', { body: { model: 'qwen', messages: shapes[1] }, headers: bearer(KV_KEY) }), env)
  assert.deepEqual(aiCalls[0].input.messages[1].content[0], { type: 'text', text: '<system-reminder>\nd\n</system-reminder>' })
})

// ---------------------------------------------------------------- CP-2

const WEB_SEARCH = {
  model: 'glm-5.3', max_tokens: 1000, stream: true,
  system: 'You are an assistant for performing a web search tool use',
  messages: [{ role: 'user', content: 'Perform a web search for the query: workers ai limits' }],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
}

test('CP-2: a request whose only tools are server tools is a 400, and no model runs', async () => {
  const { env, aiCalls } = makeEnv()
  const r = await worker.fetch(req('/v1/messages', { body: WEB_SEARCH, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 400)
  const j = await r.json()
  assert.equal(j.error.type, 'invalid_request_error')
  assert.match(j.error.message, /web search/)
  assert.equal(aiCalls.length, 0)
  // with a client tool too, the server tool is dropped as before
  const mixed = { ...WEB_SEARCH, stream: false, tools: [...WEB_SEARCH.tools, { name: 'Read', input_schema: { type: 'object' } }] }
  assert.equal((await worker.fetch(req('/v1/messages', { body: mixed, headers: bearer(KV_KEY) }), env)).status, 200)
  assert.deepEqual(aiCalls[0].input.tools.map(t => t.function.name), ['Read'])
  assert.match(README(), /"deny": \["WebSearch"\]/)
})

// ---------------------------------------------------------------- CP-3

test('CP-3: Claude Code\'s output_config.effort sets the reasoning effort', () => {
  const cc = effort => anthropicToOpenAI({ ...MSG, thinking: { type: 'adaptive' }, output_config: { effort } }).openai
  assert.equal(buildInput(model(GLM53), cc('low')).reasoning_effort, 'low')
  assert.equal(buildInput(model(GLM53), cc('max')).reasoning_effort, 'max')
  assert.equal(buildInput(model(DSV41), cc('low')).reasoning_effort, 'low')
  assert.equal(buildInput(model(QWEN), cc('max')).reasoning_effort, 'xhigh')
  assert.equal(buildInput(model(GLM53), anthropicToOpenAI({ ...MSG, thinking: { type: 'adaptive' } }).openai).reasoning_effort, 'high')
  // thinking off still wins: it asks for the lowest effort
  assert.equal(anthropicToOpenAI({ ...MSG, thinking: { type: 'disabled' }, output_config: { effort: 'high' } }).openai.reasoning_effort, 'none')
})

// ---------------------------------------------------------------- CP-4

test('CP-4: a tool_reference in a tool_result tells the model the tool is loaded', () => {
  const r = anthropicToOpenAI({
    ...MSG,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'github' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', tool_name: 'mcp__github__create_issue' }] }] },
    ],
  })
  const tool = r.openai.messages.find(m => m.role === 'tool')
  assert.match(tool.content, /Tool loaded: mcp__github__create_issue/)
  assert.ok(!/no output/.test(tool.content))
})

// ---------------------------------------------------------------- CP-5

test('CP-5: when every model says the prompt is too long, jell0 tries the big overflow models, then answers 400 "prompt is too long"', async () => {
  const tooLong = () => { throw new Error('maximum context length is 262144 tokens') }
  const cjk = '文'.repeat(400000)
  const body = { model: 'claude-haiku-4-5', max_tokens: 1000, messages: [{ role: 'user', content: cjk }] }
  const { env, aiCalls } = makeEnv({ ai: tooLong })
  const r = await worker.fetch(req('/v1/messages', { body, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 400)
  const j = await r.json()
  assert.equal(j.error.type, 'invalid_request_error')
  assert.match(j.error.message, /^prompt is too long/)
  assert.deepEqual(aiCalls.map(c => c.id), [GEMMA, '@cf/zai-org/glm-4.7-flash', OSS20, DSV41, QWEN])
  // OpenAI route: the same, with the OpenAI code for it
  const o = makeEnv({ ai: tooLong })
  const or = await worker.fetch(req('/v1/chat/completions', { body: { ...body, model: 'jell0-fast' }, headers: bearer(KV_KEY) }), o.env)
  assert.equal(or.status, 400)
  assert.equal((await or.json()).error.code, 'context_length_exceeded')
  // an overflow model that can take it answers
  const ok = makeEnv({ ai: id => { if (id !== DSV41) tooLong(); return okJSON('fits') } })
  const okr = await worker.fetch(req('/v1/messages', { body, headers: bearer(KV_KEY) }), ok.env)
  assert.equal(okr.status, 200)
  assert.equal((await okr.json()).content[0].text, 'fits')
  // glm-5.3 is never an overflow model
  assert.ok(!aiCalls.some(c => c.id === GLM53))
})

test('CP-5: the no_model_fits message on the Messages route starts with "prompt is too long"', async () => {
  const { env, aiCalls } = makeEnv()
  const r = await worker.fetch(req('/v1/messages', { body: { ...MSG, model: 'jell0-long', messages: [{ role: 'user', content: 'x'.repeat(4400000) }] }, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 400)
  assert.match((await r.json()).error.message, /^prompt is too long: \d+ tokens > \d+ maximum/)
  assert.equal(aiCalls.length, 0)
})

// ---------------------------------------------------------------- CP-6

test('CP-6: Claude Code\'s attribution block never reaches the model; README turns it off', () => {
  const r = anthropicToOpenAI({
    ...MSG,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.320; cc_entrypoint=cli; cch=abc;' }, { type: 'text', text: 'You are Claude Code.' }],
  })
  assert.deepEqual(r.openai.messages[0], { role: 'system', content: 'You are Claude Code.' })
  assert.match(README(), /export CLAUDE_CODE_ATTRIBUTION_HEADER=0/)
})

// ---------------------------------------------------------------- WAI-1

test('WAI-1: every model but the last is asked to reject when busy, so a busy model falls through at once', async () => {
  const busy = () => Object.assign(new Error('3040: Capacity temporarily exceeded, please try again.'), { status: 429 })
  const { env, aiCalls } = makeEnv({ ai: (id, input, n) => { if (n < 3) throw busy(); return okJSON('qwen here') } })
  const r = await runChain(env, { messages: [{ role: 'user', content: 'x' }] }, { chain: [GLM53, DSV41, QWEN], lane: 'flagship' })
  assert.equal(r.status, 200)
  assert.deepEqual(aiCalls.map(c => c.options), [{ rejectIfBusy: true }, { rejectIfBusy: true }, undefined])
  assert.deepEqual(aiCalls.map(c => c.args), [3, 3, 2])
  assert.ok(!('rejectIfBusy' in aiCalls[0].input), 'never in the model input')
})

// ---------------------------------------------------------------- WAI-2

test('WAI-2: the classifier counts keyword matches, so the score means something', () => {
  const lane = text => classify([{ role: 'user', content: text }])
  assert.equal(lane('write a short tweet about our new api'), 'creative')
  assert.equal(lane('Implement a red-black tree in Rust with full tests. No unsafe code.'), 'coding')
  assert.equal(lane('how to fix this bug in my python function'), 'coding')
  assert.equal(lane('why is the sky blue'), 'reasoning')
  assert.equal(lane('tell me a joke'), 'general')
  assert.equal(lane('code code code, but why?'), 'coding')
})

test('WAI-2: the smart lane never picks glm-5.3; explicit choices still do', () => {
  const prompts = ['debug my javascript code', 'why is the sky blue', 'write a poem', 'hi', 'summarize this long large document, the entire file', 'tell me a joke', 'look at this screenshot']
  for (const p of prompts) {
    for (const name of ['jell0', 'gpt-4o', '']) {
      const plan = planRoute({ model: name, messages: [{ role: 'user', content: p }] }, {}, NOW)
      assert.ok(plan.chain.length > 0, p)
      assert.ok(!plan.chain.includes(GLM53), p + ' -> ' + plan.chain)
    }
  }
  assert.deepEqual(planRoute({ model: 'jell0', messages: [{ role: 'user', content: 'debug my javascript code' }] }, {}, NOW).chain, [DSV41, QWEN, GEMMA])
  for (const name of ['jell0-coding', 'jell0-flagship', 'jell0-max', 'jell0-glm', 'glm-5.3']) {
    assert.equal(planRoute({ model: name, messages: [{ role: 'user', content: 'hi' }] }, {}, NOW).chain[0], GLM53, name)
  }
  assert.equal(planRoute({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }, { anthropic: true }, NOW).chain[0], GLM53)
  // the reasoning lane (and deepseek by name) no longer escalate to glm-5.3
  assert.ok(!LANES.reasoning.includes(GLM53))
  assert.ok(!chainFor(resolveTarget('deepseek', NOW), {}, NOW).includes(GLM53))
  assert.equal(LANES.long[0], DSV41)
})

// ---------------------------------------------------------------- WAI-3

test('WAI-3: Qwen defaults to xhigh; gpt-oss-20b takes low, medium and high', () => {
  assert.equal(model(QWEN).defaultEffort, 'xhigh')
  assert.deepEqual(model(OSS20).efforts, ['low', 'medium', 'high'])
  assert.equal(model(OSS20).defaultEffort, 'medium')
  assert.equal(buildInput(model(OSS20), { messages: [], reasoning_effort: 'high' }).reasoning_effort, 'high')
  assert.equal(buildInput(model(OSS20), anthropicToOpenAI({ ...MSG, thinking: { type: 'disabled' } }).openai).reasoning_effort, 'low')
  assert.match(README(), /\| qwen3\.8-27b, qwen \|[^\n]*xhigh \(default\)/)
})

// ---------------------------------------------------------------- WAI-4

test('WAI-4: paid models need the Workers Paid plan at 20 rpm; others 300 rpm; no credits claim', () => {
  for (const m of MODELS) assert.equal(m.rpm, m.paid ? 20 : 300, m.id)
  assert.equal(model(GLM52).rpm, 20)
  const rd = README()
  assert.ok(!/50 with prepaid/.test(rd))
  assert.ok(!/"Paid" means the\s+Workers Paid plan or prepaid AI Gateway credits/.test(rd))
  assert.match(rd, /need the Workers Paid plan/)
  const cat = readFileSync(join(JELL0, 'src', 'catalog.js'), 'utf8')
  assert.ok(!/paid = needs the Workers Paid plan\s*\/\/ or prepaid/.test(cat.replace(/\n\/\/ /g, ' // ')))
  assert.ok(!/or prepaid AI Gateway credits/.test(cat))
})

// ---------------------------------------------------------------- WAI-5

test('WAI-5: 3006 "Request is too large" stops the chain at once with a 400', async () => {
  assert.equal(errorKind(new Error('3006: Request is too large')), 'invalid')
  assert.equal(errorKind({ status: 413, message: 'Request is too large' }), 'invalid')
  const { env, aiCalls } = makeEnv({ ai: () => { throw new Error('3006: Request is too large') } })
  const r = await runChain(env, { messages: [{ role: 'user', content: 'x' }] }, { chain: [GLM53, DSV41, QWEN], lane: 'flagship' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error.message, /Request is too large/)
  assert.equal(aiCalls.length, 1)
})
