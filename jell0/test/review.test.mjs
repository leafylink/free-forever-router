// Tests for the 2026-11-07 review findings (ids in each test name). Fake env
// only: a KV map, an AI mock with run(), a D1 mock. No network.
// Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import worker from '../src/index.js'
import { planRoute, chainFor, resolveTarget, MODELS } from '../src/catalog.js'
import { runChain, buildInput, normalizeJSON, sseNormalizer } from '../src/workersai.js'
import { managerKeyOk, clearKeyCache } from '../src/keys.js'
import { anthropicToOpenAI, openAIToAnthropic, openAISSEToAnthropicSSE } from '../src/anthropic.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const JELL0 = join(HERE, '..')
const REPO = join(JELL0, '..')

const GLM53 = '@cf/zai-org/glm-5.3'
const DSV41 = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
const QWEN = '@cf/qwen/qwen3.8-27b'
const GEMMA = '@cf/google/gemma-4-26b-a4b-it'
const GLM47F = '@cf/zai-org/glm-4.7-flash'
const OSS20 = '@cf/openai/gpt-oss-20b'
const OSS120 = '@cf/openai/gpt-oss-120b'
const SCOUT = '@cf/meta/llama-4-scout-17b-16e-instruct'
const NOW = Date.parse('2026-11-10T00:00:00Z')
const model = id => MODELS.find(m => m.id === id)

const h = s => createHash('sha256').update(s).digest('hex')
const KV_KEY = 'review-kv-key-aaaaaaaaaaaaaaaaaaaa'
const KV_PLAIN = 'review-old-plain-key-bbbbbbbbbbbb'
const MGR_OK = 'llk_' + h('review manager key')
const enc = new TextEncoder()
const dec = new TextDecoder()

// ---------------------------------------------------------------- fakes

function makeEnv(ai, { rows } = {}) {
  const store = new Map([
    ['key:' + h(KV_KEY), JSON.stringify({ id: 'k1', label: 'hashed', hint: KV_KEY.slice(-4), created: '2026-11-07T00:00:00.000Z' })],
    ['api_keys', JSON.stringify([{ id: 'k2', label: 'old plain', key: KV_PLAIN }])],
  ])
  const aiCalls = []
  const sqls = []
  const table = rows ?? [{ hash: h(MGR_OK), perms: 'ai_models', revoked_at: null }]
  const env = {
    JELL0_ADMIN_TOKEN: 'jell0-admin-v2.review-admin-token-0123456789abcdef-0123456789',
    AI: {
      async run(id, input) {
        aiCalls.push({ id, input: structuredClone(input) })
        return ai ? ai(id, input, aiCalls.length) : okJSON()
      },
    },
    JELL0_CONFIG: {
      async get(k) { return store.has(k) ? store.get(k) : null },
      async put(k, v) { store.set(k, v) },
      async delete(k) { store.delete(k) },
      async list({ prefix = '' } = {}) {
        return { keys: [...store.keys()].filter(n => n.startsWith(prefix)).map(name => ({ name, metadata: JSON.parse(store.get(name)) })), list_complete: true }
      },
    },
    MGR_DB: {
      prepare(sql) {
        sqls.push(sql)
        return { bind(hash) { return { async first() { return table.find(r => r.hash === hash && r.revoked_at == null) || null } } } }
      },
    },
  }
  return { env, aiCalls, sqls }
}

function okJSON(message = { content: 'hello' }, extra = {}) {
  return { choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop', ...extra }], usage: { prompt_tokens: 3, completion_tokens: 2 } }
}

const sse = list => list.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join('')

function streamOf(events) {
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(sse(events))); c.close() } })
}

// A stream the test feeds by hand; it stays open until finish().
function heldStream() {
  let ctl
  const s = new ReadableStream({ start(c) { ctl = c } })
  s.send = e => ctl.enqueue(enc.encode(sse([e])))
  s.finish = () => ctl.close()
  return s
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

function openaiChunks(text) {
  return text.split('\n\n').filter(Boolean).map(b => b.replace(/^data: /, '')).filter(d => d !== '[DONE]').map(d => JSON.parse(d))
}

function anthropicEvents(text) {
  return text.split('\n\n').filter(Boolean).map(b => {
    const [ev, data] = b.split('\n')
    return { event: ev.slice(7), data: JSON.parse(data.slice(6)) }
  })
}

async function readAll(stream) {
  const r = stream.getReader()
  let t = ''
  for (;;) {
    const { value, done } = await r.read()
    if (done) return t + dec.decode()
    t += dec.decode(value, { stream: true })
  }
}

// Read from a reader until `until(text)` holds, or fail after ms.
async function readUntil(reader, until, ms = 1000) {
  let text = ''
  const deadline = Date.now() + ms
  while (!until(text)) {
    const left = deadline - Date.now()
    if (left <= 0) return { text, timedOut: true }
    let timer
    const r = await Promise.race([reader.read(), new Promise(res => { timer = setTimeout(() => res('timeout'), left) })])
    clearTimeout(timer)
    if (r === 'timeout') return { text, timedOut: true }
    if (r.done) return { text, timedOut: !until(text) }
    text += dec.decode(r.value, { stream: true })
  }
  return { text, timedOut: false }
}

// ---------------------------------------------------------------- SEC-1

// The phase A legacy key is gone (core.test.mjs proves it is 401 everywhere).
test('SEC-1: no test, source or doc line hints at what the legacy bearer is', () => {
  const files = ['test/core.test.mjs', 'test/e2e.test.mjs', 'test/anthropic.test.mjs', 'src/keys.js', 'src/index.js', 'README.md']
  for (const f of files) {
    const text = readFileSync(join(JELL0, f), 'utf8')
    assert.ok(!/legacy bearer[^\n]*\bword\b/i.test(text), f)
  }
})

// ---------------------------------------------------------------- COST-1 / R4

test('COST-1: cheap lanes and cheap models never overflow to glm-5.3', () => {
  const huge = { messages: [{ role: 'user', content: bigText(500000) }] }
  for (const name of ['jell0-free', 'jell0-budget', 'jell0-flatline', 'jell0-simple', 'jell0-fast', 'gemma', 'glm-4.7-flash', 'gpt-oss-20b']) {
    const p = planRoute({ ...huge, model: name }, {}, NOW)
    assert.ok(!p.chain.includes(GLM53), name + ' -> ' + p.chain)
    assert.deepEqual(p.chain, [DSV41], name)
  }
})

test('R4: a model fits only when the prompt plus the output budget fit its context', () => {
  const at250k = { model: 'jell0-free', messages: [{ role: 'user', content: bigText(250000) }] }
  assert.deepEqual(planRoute(at250k, {}, NOW).chain, [DSV41], 'gemma (256k) cannot hold 250k plus 16k of output')
  assert.equal(planRoute({ ...at250k, max_tokens: 1000 }, {}, NOW).chain[0], GEMMA, 'with a small answer it still fits')
  assert.deepEqual(chainFor(resolveTarget('jell0-fast', NOW), { tokens: 120000, output: 16384 }, NOW), [GEMMA])
})

// ---------------------------------------------------------------- COST-2

test('COST-2: a Responses API reply is read, not thrown away', async () => {
  const resp = {
    id: 'resp_1', object: 'response', status: 'completed',
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { type: 'function_call', call_id: 'call_x', name: 'read', arguments: '{"p":"a"}' },
    ],
    output_text: 'answer',
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  }
  const j = normalizeJSON(resp, OSS120)
  assert.equal(j.object, 'chat.completion')
  assert.equal(j.choices[0].message.content, 'answer')
  assert.equal(j.choices[0].message.reasoning_content, 'thinking')
  assert.deepEqual(j.choices[0].message.tool_calls, [{ id: 'call_x', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }])
  assert.equal(j.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(j.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })
  const { env, aiCalls } = makeEnv(() => ({ object: 'response', output: [], output_text: 'answer', usage: { input_tokens: 1, output_tokens: 1 } }))
  const r = await runChain(env, { messages: [{ role: 'user', content: 'x' }] }, { chain: [OSS120, OSS20], lane: 'reasoning' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).choices[0].message.content, 'answer')
  assert.equal(aiCalls.length, 1)
})

test('COST-2: a reply jell0 cannot read is a 502 after one call, never a second billed call', async () => {
  const { env, aiCalls } = makeEnv(() => ({ something: 'else' }))
  const r = await runChain(env, { messages: [{ role: 'user', content: 'x' }] }, { chain: [OSS120, OSS20], lane: 'reasoning' })
  assert.equal(r.status, 502)
  assert.equal((await r.json()).error.code, 'unreadable_reply')
  assert.equal(aiCalls.length, 1)
  const { env: env2, aiCalls: calls2 } = makeEnv(() => ({ something: 'else' }))
  const s = await runChain(env2, { messages: [{ role: 'user', content: 'x' }] }, { stream: true, chain: [OSS120, OSS20] })
  assert.equal(s.status, 502)
  assert.equal(calls2.length, 1)
})

// ---------------------------------------------------------------- SEC-2

test('SEC-2: keys not shaped like a Manager key never reach D1', async () => {
  clearKeyCache()
  const { env, sqls, aiCalls } = makeEnv()
  for (let i = 0; i < 50; i++) {
    const r = await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer('junk-' + i) }), env)
    assert.equal(r.status, 401)
  }
  assert.equal(sqls.length, 0)
  assert.equal(aiCalls.length, 0)
  assert.equal(await managerKeyOk(env, 'llk_short'), false)
  assert.equal(sqls.length, 0)
  assert.equal(await managerKeyOk(env, MGR_OK), true)
  assert.equal(sqls.length, 1)
})

test('SEC-2: a flood of unknown keys does not flush a Manager key that is in use', async () => {
  clearKeyCache()
  const { env, sqls } = makeEnv()
  assert.equal(await managerKeyOk(env, MGR_OK), true)
  for (let i = 0; i < 999; i++) await managerKeyOk(env, 'llk_' + h('unknown ' + i))
  assert.equal(await managerKeyOk(env, MGR_OK), true) // a hit: no query, moves to the back
  for (let i = 999; i < 1500; i++) await managerKeyOk(env, 'llk_' + h('unknown ' + i))
  const before = sqls.length
  assert.equal(await managerKeyOk(env, MGR_OK), true)
  assert.equal(sqls.length, before, 'still cached')
  clearKeyCache()
})

// ---------------------------------------------------------------- ROBUST-1 / R5

test('ROBUST-1/R5: names that are Object.prototype keys go to the smart lane, not a 500', async () => {
  for (const name of ['constructor', '__proto__', 'jell0-constructor', 'toString', 'hasOwnProperty', 'jell0-__proto__']) {
    const t = resolveTarget(name, NOW)
    assert.equal(t.lane, 'smart', name)
    const p = planRoute({ model: name, messages: [{ role: 'user', content: 'hello' }] }, {}, NOW)
    assert.ok(p.chain.length > 0, name)
  }
  const { env } = makeEnv()
  for (const pref of ['constructor', '__proto__']) {
    const s = await worker.fetch(req('/select?prompt=hi&pref=' + pref, { method: 'GET' }), env)
    assert.equal(s.status, 200, pref)
    const c = await worker.fetch(req('/v1/chat/completions', { body: { ...CHAT, model: pref }, headers: bearer(KV_KEY) }), env)
    assert.equal(c.status, 200, pref)
    const x = await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: { ...bearer(KV_KEY), 'X-Jell0-Preference': pref } }), env)
    assert.equal(x.status, 200, pref)
  }
})

// ---------------------------------------------------------------- R1

test('R1: plain KV entries from the old open admin API are not keys; the list says so', async () => {
  const { env } = makeEnv()
  assert.equal((await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(KV_PLAIN) }), env)).status, 401)
  assert.equal((await worker.fetch(req('/v1/messages', { body: MSG, headers: { 'x-api-key': KV_PLAIN } }), env)).status, 401)
  assert.equal((await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(KV_KEY) }), env)).status, 200)
  const list = await (await worker.fetch(req('/api/jell0/keys', { method: 'GET', headers: bearer(env.JELL0_ADMIN_TOKEN) }), env)).json()
  const plain = list.keys.find(k => k.id === 'k2')
  assert.match(plain.stored, /NOT accepted/)
  assert.ok(!JSON.stringify(list).includes(KV_PLAIN))
})

// ---------------------------------------------------------------- OPS-1, R1, R2, R7: owner steps written down

test('OPS-1/R1/R2/R7: README, wrangler.toml and the workflow carry the pre and post deploy steps', () => {
  const readme = readFileSync(join(JELL0, 'README.md'), 'utf8')
  const deploy = readme.slice(readme.indexOf('## Deploy'))
  assert.ok(deploy.length > 100, 'README has a Deploy section')
  for (const name of ['OPENROUTER_API_KEY', 'HUGGINGFACE_TOKEN', 'DEEPSEEK_API_KEY', 'ORCAROUTER_API_KEY', 'GEMINI_API_KEY']) {
    assert.ok(deploy.includes(name), 'README Deploy says to delete ' + name)
  }
  assert.match(deploy, /does not delete Worker secrets/)
  assert.match(deploy, /fresh `JELL0_ADMIN_TOKEN`/)
  assert.match(deploy, /`providers` entry/)
  assert.match(deploy, /git add -f \.github\/workflows\/jell0-deploy\.yml/)
  assert.match(deploy, /deploy-jell0-router\.yml/)
  assert.match(deploy, /fix\/deploy-workflow-2026-10-25/)
  const toml = readFileSync(join(JELL0, 'wrangler.toml'), 'utf8')
  assert.match(toml, /^# BEFORE THE FIRST DEPLOY: set a fresh JELL0_ADMIN_TOKEN/m)
})

test('R2/R6: the deploy workflow exists, is dispatch only, and has a keyed smoke check that never prints the key', () => {
  const wf = join(REPO, '.github', 'workflows', 'jell0-deploy.yml')
  assert.ok(existsSync(wf), 'jell0-deploy.yml is missing (it is git-ignored: add it by hand, see README)')
  const y = readFileSync(wf, 'utf8')
  const on = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(y)
  assert.ok(on, 'workflow has an on: block')
  const triggers = on[1].split('\n').filter(l => /^ {2}\S/.test(l)).map(l => l.trim().replace(/:.*$/, ''))
  assert.deepEqual(triggers, ['workflow_dispatch'])
  assert.match(y, /^# BEFORE THE FIRST RUN:/m)
  assert.match(y, /SMOKE_KEY: \$\{\{ secrets\.JELL0_SMOKE_KEY \}\}/)
  assert.match(y, /if \[ -z "\$\{SMOKE_KEY:-\}" \]; then echo "skip keyed check/)
  assert.match(y, /"model":"jell0-fast","max_tokens":1/)
  assert.match(y, /workersai\//)
  assert.ok(!/echo[^\n]*\$\{?SMOKE_KEY|set -x/.test(y), 'the key is never echoed')
})

// ---------------------------------------------------------------- P1

test('P1: /v1/messages streams tool call arguments as they arrive, before the upstream ends', async () => {
  const up = heldStream()
  const reader = openAISSEToAnthropicSSE(up, 'glm-5.3').getReader()
  up.send({ choices: [{ index: 0, delta: { content: 'Writing.' } }] })
  up.send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'Write', arguments: '' } }] } }] })
  up.send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":"a.txt",' } }] } }] })
  up.send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"big' } }] } }] })
  const { text, timedOut } = await readUntil(reader, t => (t.match(/input_json_delta/g) || []).length >= 2)
  assert.equal(timedOut, false, 'tool_use start and two input_json_delta pieces arrive while the upstream is still open')
  const evs = anthropicEvents(text)
  const start = evs.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
  assert.deepEqual(start.data.content_block, { type: 'tool_use', id: 'call_w', name: 'Write', input: {} })
  assert.ok(evs.some(e => e.event === 'content_block_stop' && e.data.index === 0), 'the text block closed first')
  up.send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' file"}' } }] } }] })
  up.send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  up.send('[DONE]')
  up.finish()
  let rest = ''
  for (;;) { const { value, done } = await reader.read(); if (done) break; rest += dec.decode(value) }
  const all = anthropicEvents(text + rest)
  const json = all.filter(e => e.data.delta && e.data.delta.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('')
  assert.deepEqual(JSON.parse(json), { file_path: 'a.txt', content: 'big file' })
  assert.equal(all.at(-1).event, 'message_stop')
})

test('P1: a ping event goes out while the upstream is silent', async () => {
  const up = heldStream()
  const reader = openAISSEToAnthropicSSE(up, 'glm-5.3', { pingMs: 20 }).getReader()
  const { text, timedOut } = await readUntil(reader, t => t.includes('event: ping'), 1000)
  assert.equal(timedOut, false)
  assert.ok(text.includes('event: ping\ndata: {"type":"ping"}\n\n'))
  await reader.cancel()
})

// ---------------------------------------------------------------- P2

test('P2: streams ask models for usage, and usage after finish_reason still reaches the client', async () => {
  for (const id of [GLM53, DSV41, QWEN, GEMMA, GLM47F]) {
    assert.deepEqual(buildInput(model(id), { messages: [], stream: true, stream_options: { include_usage: false } }, true).stream_options, { include_usage: true }, id)
  }
  assert.equal(buildInput(model(SCOUT), { messages: [] }, true).stream_options, undefined)
  assert.equal(buildInput(model(GLM53), { messages: [] }, false).stream_options, undefined)
  const norm = sseNormalizer(GLM53)
  let out = norm.push(sse([{ choices: [{ index: 0, delta: { content: 'hi' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { usage: { prompt_tokens: 900, completion_tokens: 7 } }]))
  out += norm.end()
  const withUsage = openaiChunks(out).filter(c => c.usage)
  assert.equal(withUsage.length, 1)
  assert.deepEqual(withUsage[0].choices, [])
  assert.equal(withUsage[0].usage.prompt_tokens, 900)
  // and Claude Code sees it on /v1/messages
  const { env } = makeEnv(() => streamOf([
    { choices: [{ index: 0, delta: { content: 'hi' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 900, completion_tokens: 7 } },
    '[DONE]',
  ]))
  const r = await worker.fetch(req('/v1/messages', { body: { ...MSG, stream: true }, headers: bearer(KV_KEY) }), env)
  const md = anthropicEvents(await r.text()).find(e => e.event === 'message_delta')
  assert.equal(md.data.usage.input_tokens, 900)
  assert.equal(md.data.usage.output_tokens, 7)
})

// ---------------------------------------------------------------- P3

test('P3: tool call pieces with no index are kept apart by id', async () => {
  const norm = sseNormalizer(SCOUT)
  const out = norm.push(sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{"p":"a"}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_2', function: { name: 'glob', arguments: '{"q":"*"}' } }] } }] },
  ])) + norm.end()
  const parts = openaiChunks(out).flatMap(c => c.choices.flatMap(x => x.delta.tool_calls || []))
  assert.deepEqual(parts.map(p => [p.index, p.id, p.function.name]), [[0, 'call_1', 'read'], [1, 'call_2', 'glob']])
  const { env } = makeEnv(() => streamOf([
    { choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{"p":"a"}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_2', function: { name: 'glob', arguments: '{"q":"*"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]))
  const r = await worker.fetch(req('/v1/messages', { body: { ...MSG, stream: true }, headers: bearer(KV_KEY) }), env)
  const evs = anthropicEvents(await r.text())
  const tools = evs.filter(e => e.event === 'content_block_start').map(e => e.data.content_block)
  assert.deepEqual(tools.map(b => [b.id, b.name]), [['call_1', 'read'], ['call_2', 'glob']])
})

// ---------------------------------------------------------------- P4

test('P4: disable_parallel_tool_use reaches models that take it, and only one tool call comes back', async () => {
  const tools = [{ name: 'read', description: 'r', input_schema: { type: 'object', properties: {} } }]
  const t = anthropicToOpenAI({ ...MSG, tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } })
  assert.equal(buildInput(model(GLM53), t.openai).parallel_tool_calls, false)
  const two = { content: null, tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } },
    { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } },
  ] }
  const { env, aiCalls } = makeEnv(() => okJSON(two, { finish_reason: 'tool_calls' }))
  const r = await worker.fetch(req('/v1/messages', { body: { ...MSG, tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } }, headers: bearer(KV_KEY) }), env)
  const m = await r.json()
  assert.equal(aiCalls[0].input.parallel_tool_calls, false)
  assert.deepEqual(m.content.filter(b => b.type === 'tool_use').map(b => b.id), ['c1'])
  // a model without the field (llama-4-scout) is trimmed the same way, JSON and stream
  const j = await (await runChain(makeEnv(() => okJSON(two)).env, { messages: [], parallel_tool_calls: false }, { chain: [SCOUT] })).json()
  assert.equal(j.choices[0].message.tool_calls.length, 1)
  const s = await readAll((await runChain(makeEnv(() => streamOf([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } }, { index: 1, id: 'c2', function: { name: 'b', arguments: '{}' } }] } }] },
    '[DONE]',
  ])).env, { messages: [], parallel_tool_calls: false }, { stream: true, chain: [SCOUT] })).body)
  const ids = openaiChunks(s).flatMap(c => c.choices.flatMap(x => x.delta.tool_calls || [])).map(p => p.id)
  assert.deepEqual(ids, ['c1'])
})

// ---------------------------------------------------------------- P5

test('P5: thinking disabled asks each model for its lowest effort', () => {
  const off = anthropicToOpenAI({ ...MSG, thinking: { type: 'disabled' } }).openai
  assert.equal(buildInput(model(GLM53), off).reasoning_effort, 'low') // glm-5.3 cannot turn reasoning off
  assert.equal(buildInput(model(DSV41), off).reasoning_effort, 'none')
  assert.deepEqual(buildInput(model(GEMMA), off).chat_template_kwargs, { enable_thinking: false })
  assert.equal(buildInput(model(DSV41), { messages: [], thinking: { type: 'disabled' } }).reasoning_effort, 'none')
})

// ---------------------------------------------------------------- P6

test('P6: an invalid request stops at once with a 400; context errors still fall back', async () => {
  const invalid = () => { throw new Error('8001: Invalid input: messages.3.content.0.type must be text or image_url') }
  const a = makeEnv(invalid)
  const m = await worker.fetch(req('/v1/messages', { body: MSG, headers: bearer(KV_KEY) }), a.env)
  assert.equal(m.status, 400)
  const mj = await m.json()
  assert.equal(mj.type, 'error')
  assert.equal(mj.error.type, 'invalid_request_error')
  assert.match(mj.error.message, /8001: Invalid input/)
  assert.equal(a.aiCalls.length, 1)
  const b = makeEnv(invalid)
  const o = await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(KV_KEY) }), b.env)
  assert.equal(o.status, 400)
  assert.equal((await o.json()).error.code, 'invalid_request')
  assert.equal(b.aiCalls.length, 1)
  const c = makeEnv((id, input, n) => { if (n === 1) throw new Error('8001: Invalid input: the prompt exceeds the maximum context length'); return okJSON() })
  const ok = await worker.fetch(req('/v1/chat/completions', { body: CHAT, headers: bearer(KV_KEY) }), c.env)
  assert.equal(ok.status, 200)
  assert.equal(c.aiCalls.length, 2)
})

// ---------------------------------------------------------------- P7

test('P7: a document inside a tool_result is not dropped as "(no output)"', () => {
  const t = anthropicToOpenAI({
    ...MSG,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } }] },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'document', source: { type: 'text', data: 'plain text body' } }] },
      ] },
    ],
  })
  const toolMsgs = t.openai.messages.filter(m => m.role === 'tool')
  assert.equal(toolMsgs[0].content, '[document omitted: jell0 only passes text documents]')
  assert.equal(toolMsgs[1].content, 'plain text body')
})

// ---------------------------------------------------------------- P8

test('P8: Responses API stream events are read, never pasted into the answer as JSON', () => {
  const norm = sseNormalizer(OSS120)
  const out = norm.push(sse([
    { type: 'response.created', response: { id: 'resp_1', object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.reasoning_text.delta', delta: 'hmm' },
    { type: 'response.output_text.delta', delta: 'Hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call_r', name: 'read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"p":1}' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3 } } },
  ])) + norm.end()
  assert.ok(!out.includes('resp_1'))
  const chunks = openaiChunks(out)
  const deltas = chunks.flatMap(c => c.choices.map(x => x.delta))
  assert.equal(deltas.map(d => d.content || '').join(''), 'Hello')
  assert.equal(deltas.map(d => d.reasoning_content || '').join(''), 'hmm')
  const parts = deltas.flatMap(d => d.tool_calls || [])
  assert.equal(parts[0].id, 'call_r')
  assert.equal(parts.map(p => p.function.arguments).join(''), '{"p":1}')
  const last = chunks.at(-1)
  assert.equal(last.choices[0].finish_reason, 'tool_calls')
  assert.equal(last.usage.prompt_tokens, 5)
})

// ---------------------------------------------------------------- P9

test('P9: stop_sequence is reported when the model says which stop string it hit', async () => {
  const m = openAIToAnthropic(okJSON({ content: 'abc' }, { stop_reason: 'END' }), 'm', ['END'])
  assert.equal(m.stop_reason, 'stop_sequence')
  assert.equal(m.stop_sequence, 'END')
  assert.equal(openAIToAnthropic(okJSON({ content: 'abc' }), 'm', ['END']).stop_reason, 'end_turn')
  assert.equal(openAIToAnthropic(okJSON({ content: 'abc' }, { stop_reason: 'other' }), 'm', ['END']).stop_reason, 'end_turn')
  const j = makeEnv(() => okJSON({ content: 'abc' }, { stop_reason: 'END' }))
  const r = await worker.fetch(req('/v1/messages', { body: { ...MSG, stop_sequences: ['END'] }, headers: bearer(KV_KEY) }), j.env)
  const body = await r.json()
  assert.equal(body.stop_reason, 'stop_sequence')
  assert.equal(body.stop_sequence, 'END')
  const s = makeEnv(() => streamOf([
    { choices: [{ index: 0, delta: { content: 'abc' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop', stop_reason: 'END' }] },
    '[DONE]',
  ]))
  const rs = await worker.fetch(req('/v1/messages', { body: { ...MSG, stream: true, stop_sequences: ['END'] }, headers: bearer(KV_KEY) }), s.env)
  const md = anthropicEvents(await rs.text()).find(e => e.event === 'message_delta')
  assert.deepEqual(md.data.delta, { stop_reason: 'stop_sequence', stop_sequence: 'END' })
})

// ---------------------------------------------------------------- P10

test('P10: like the old jell0, any path ending in /chat/completions or /models works', async () => {
  const { env } = makeEnv()
  for (const path of ['/openai/v1/chat/completions', '/api/v1/chat/completions', '/v1/chat/completions/']) {
    const r = await worker.fetch(req(path, { body: CHAT, headers: bearer(KV_KEY) }), env)
    assert.equal(r.status, 200, path)
  }
  for (const path of ['/api/v1/models', '/openai/v1/models']) {
    const r = await worker.fetch(req(path, { method: 'GET' }), env)
    assert.equal(r.status, 200, path)
    assert.equal((await r.json()).object, 'list')
  }
  assert.equal((await worker.fetch(req('/openai/v1/chat/completions', { body: CHAT }), env)).status, 401)
  assert.equal((await worker.fetch(req('/api/jell0/providers', { method: 'GET' }), env)).status, 404)
  assert.equal((await worker.fetch(req('/api/jell0/discover', { method: 'GET' }), env)).status, 404)
})
