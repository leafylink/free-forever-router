// End-to-end tests for jell0: real client-shaped requests go through the
// Worker's default export fetch() with a fake env (KV map, AI mock with run(),
// D1 mock with prepare().bind().first()). No network, no Cloudflare.
// Run from the repo root: node --test jell0/test/*.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import worker from '../src/index.js'
import { clearKeyCache } from '../src/keys.js'

const GLM53 = '@cf/zai-org/glm-5.3'
const DSV41 = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
const QWEN = '@cf/qwen/qwen3.8-27b'
const GEMMA = '@cf/google/gemma-4-26b-a4b-it'
const TOP = [GLM53, DSV41, QWEN]

const ADMIN = 'jell0-admin-v2.e2e-admin-token-0123456789abcdef-0123456789' // v2 format: 40+ after the dot
const KV_KEY = 'e2e-kv-key-for-opencode-aaaaaaaaaaaa'
const h = s => createHash('sha256').update(s).digest('hex')
const MGR_KEY = 'llk_' + h('e2e manager key with ai_models')
const MGR_NO_PERM = 'llk_' + h('e2e manager key no ai_models')
const enc = new TextEncoder()

// ---------------------------------------------------------------- fakes

// ai(id, input, n) decides each Workers AI reply; it may throw.
function makeEnv(ai) {
  const store = new Map([['key:' + h(KV_KEY), JSON.stringify({ id: 'k1', label: 'opencode', hint: KV_KEY.slice(-4), created: '2026-11-07T00:00:00.000Z' })]])
  const meta = new Map()
  const aiCalls = []
  const sqls = []
  const rows = [
    { hash: h(MGR_KEY), perms: 'ai_models', revoked_at: null },
    { hash: h(MGR_NO_PERM), perms: 'production', revoked_at: null },
  ]
  const base = {
    JELL0_ADMIN_TOKEN: ADMIN,
    AI: {
      async run(id, input) {
        aiCalls.push({ id, input: structuredClone(input) })
        return ai(id, input, aiCalls.length)
      },
    },
    JELL0_CONFIG: {
      async get(k) { return store.has(k) ? store.get(k) : null },
      async put(k, v, opts = {}) { store.set(k, v); meta.set(k, opts.metadata ?? null) },
      async delete(k) { store.delete(k); meta.delete(k) },
      async list({ prefix = '' } = {}) {
        return { keys: [...store.keys()].filter(n => n.startsWith(prefix)).map(name => ({ name, metadata: meta.get(name) ?? JSON.parse(store.get(name)) })), list_complete: true }
      },
    },
    // Workers Rate Limiting bindings that never refuse here
    JELL0_IP_LIMIT: { async limit() { return { success: true } } },
    JELL0_KEY_LIMIT: { async limit() { return { success: true } } },
    MGR_DB: {
      prepare(sql) {
        sqls.push(sql)
        return {
          bind(hash) {
            return { async first() { return rows.find(r => r.hash === hash && r.revoked_at == null) || null } }
          },
        }
      },
    },
  }
  // Reading any other env name (a provider secret, say) fails the test.
  const env = new Proxy(base, {
    get(t, k) {
      if (typeof k === 'string' && !(k in t)) throw new Error('jell0 read env.' + k)
      return t[k]
    },
  })
  return { env, aiCalls, sqls, store }
}

// A Workers AI streaming reply: SSE bytes, one enqueue per event.
function sse(events) {
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode('data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n'))
      c.close()
    },
  })
}

function chatJSON(message, finish = 'stop', usage = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 }) {
  return { id: 'chatcmpl-upstream1', object: 'chat.completion', created: 1, model: 'x', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage }
}

function call(path, { method = 'POST', body, headers = {} } = {}) {
  return new Request('https://jell0-router.example.workers.dev' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const bearer = k => ({ Authorization: 'Bearer ' + k })

// OpenAI SSE text -> [parsed JSON chunks..., '[DONE]']
function openaiEvents(text) {
  assert.ok(text.endsWith('\n\n'), 'every SSE event ends with a blank line')
  return text.split('\n\n').filter(Boolean).map(block => {
    assert.ok(block.startsWith('data: '), 'OpenAI SSE lines start with data: ' + block)
    const d = block.slice(6)
    return d === '[DONE]' ? d : JSON.parse(d)
  })
}

// Anthropic SSE text -> [{ event, data }], checking event: matches data.type.
function anthropicEvents(text) {
  return text.split('\n\n').filter(Boolean).map(block => {
    const m = /^event: (\S+)\ndata: (.+)$/.exec(block)
    assert.ok(m, 'bad Anthropic SSE block: ' + block)
    const data = JSON.parse(m[2])
    assert.equal(data.type, m[1], 'event name matches data.type')
    return { event: m[1], data }
  })
}

// One short label per Anthropic event, for exact order checks.
function shape(evs) {
  return evs.map(({ event, data }) => {
    if (event === 'content_block_start') return event + ':' + data.index + ':' + data.content_block.type
    if (event === 'content_block_delta') return event + ':' + data.index + ':' + data.delta.type
    if (event === 'content_block_stop') return event + ':' + data.index
    if (event === 'message_delta') return event + ':' + data.delta.stop_reason
    return event
  })
}

// ---------------------------------------------------------------- OpenCode

const OPENCODE_TOOLS = [{
  type: 'function',
  function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
}]

const opencodeBody = extra => ({
  model: 'jell0-flagship',
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 100000,
  messages: [
    { role: 'system', content: 'You are opencode, a coding agent.' },
    { role: 'user', content: 'Open package.json and tell me the name.' },
  ],
  tools: OPENCODE_TOOLS,
  tool_choice: 'auto',
  provider: { order: ['x'] },
  ...extra,
})

// Two upstream shapes, same client result.
const OPENCODE_UPSTREAMS = {
  'Chat Completions chunks': () => sse([
    { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Need the file.' } }] },
    { choices: [{ index: 0, delta: { content: 'Reading it.' } }] },
    // no id from upstream: jell0 must give the call one
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"filePath":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"package.json"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 } },
    '[DONE]',
  ]),
  'older { response, tool_calls } stream': () => sse([
    { response: 'Reading it.' },
    { response: '', tool_calls: [{ name: 'read', arguments: { filePath: 'package.json' } }] },
    { response: '', usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 } },
    '[DONE]',
  ]),
}

for (const [name, upstream] of Object.entries(OPENCODE_UPSTREAMS)) {
  test('OpenCode: streaming chat to jell0-flagship with a tool call (' + name + ')', async () => {
    const { env, aiCalls } = makeEnv(() => upstream())
    const r = await worker.fetch(call('/v1/chat/completions', { body: opencodeBody(), headers: bearer(KV_KEY) }), env)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /^text\/event-stream/)
    assert.equal(r.headers.get('X-Jell0-Routed'), 'workersai/' + GLM53)
    assert.equal(r.headers.get('X-Jell0-Lane'), 'flagship')

    // What Workers AI got: the flagship model, tools, a capped max_tokens, no foreign fields.
    assert.equal(aiCalls.length, 1)
    const { id, input } = aiCalls[0]
    assert.equal(id, GLM53)
    assert.equal(input.stream, true)
    assert.equal(input.max_tokens, 32768)
    assert.deepEqual(input.tools, OPENCODE_TOOLS)
    assert.equal(input.tool_choice, 'auto')
    assert.equal(input.messages.length, 2)
    for (const k of ['model', 'provider']) assert.equal(input[k], undefined, k + ' must not reach Workers AI')
    assert.deepEqual(input.stream_options, { include_usage: true }, 'a stream asks for usage')

    // What OpenCode gets: OpenAI chunks, one id, model = catalog id, tool call with an id, [DONE] last.
    const evs = openaiEvents(await r.text())
    assert.equal(evs.at(-1), '[DONE]')
    assert.equal(evs.filter(e => e === '[DONE]').length, 1)
    const chunks = evs.slice(0, -1)
    assert.ok(chunks.length >= 2)
    for (const c of chunks) {
      assert.equal(c.object, 'chat.completion.chunk')
      assert.equal(c.model, GLM53)
      assert.equal(c.id, chunks[0].id)
      assert.match(c.id, /^chatcmpl-/)
      assert.equal(typeof c.created, 'number')
      assert.ok(Array.isArray(c.choices))
    }
    const deltas = chunks.flatMap(c => c.choices.map(x => x.delta))
    assert.equal(deltas.map(d => d.content || '').join(''), 'Reading it.')
    const parts = deltas.flatMap(d => d.tool_calls || [])
    assert.ok(parts.length >= 1)
    assert.ok(parts.every(p => p.index === 0))
    assert.match(parts[0].id, /^call_[0-9a-f]{24}$/)
    assert.ok(parts.slice(1).every(p => p.id === undefined || p.id === parts[0].id), 'one call, one id')
    assert.equal(parts[0].type, 'function')
    assert.equal(parts[0].function.name, 'read')
    assert.deepEqual(JSON.parse(parts.map(p => p.function.arguments || '').join('')), { filePath: 'package.json' })
    const finishes = chunks.flatMap(c => c.choices.map(x => x.finish_reason)).filter(Boolean)
    assert.deepEqual(finishes, ['tool_calls'])
    const usage = chunks.map(c => c.usage).filter(Boolean).at(-1)
    assert.deepEqual(usage, { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 })
  })
}

test('OpenCode: the tool result goes back and the final answer is plain JSON', async () => {
  const { env, aiCalls } = makeEnv(() => chatJSON({ content: 'The name is jell0-router.' }))
  const body = {
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: 'Open package.json and tell me the name.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_up1', type: 'function', function: { name: 'read', arguments: '{"filePath":"package.json"}' } }] },
      { role: 'tool', tool_call_id: 'call_up1', content: '{"name":"jell0-router"}' },
    ],
    tools: OPENCODE_TOOLS,
  }
  const r = await worker.fetch(call('/chat/completions', { body, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 200)
  assert.equal(aiCalls[0].id, GLM53)
  const sent = aiCalls[0].input.messages
  assert.equal(sent[1].tool_calls[0].id, 'call_up1')
  assert.equal(sent[1].content, '')
  assert.deepEqual(sent[2], { role: 'tool', tool_call_id: 'call_up1', content: '{"name":"jell0-router"}' })
  const j = await r.json()
  assert.equal(j.object, 'chat.completion')
  assert.equal(j.model, GLM53)
  assert.equal(j.choices[0].message.content, 'The name is jell0-router.')
  assert.equal(j.choices[0].finish_reason, 'stop')
  assert.deepEqual(j.usage, { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 })
})

// ---------------------------------------------------------------- vision

const IMAGE = 'data:image/png;base64,iVBORw0KGgo='

test('vision: a request with an image goes to a vision model, whatever lane it names', async () => {
  const { env, aiCalls } = makeEnv(() => chatJSON({ content: 'A green leaf.' }))
  const msg = [{ role: 'user', content: [{ type: 'text', text: 'hello there' }, { type: 'image_url', image_url: { url: IMAGE } }] }]

  // smart lane: images always mean the vision lane
  const a = await worker.fetch(call('/v1/chat/completions', { body: { model: 'jell0', messages: msg }, headers: bearer(KV_KEY) }), env)
  assert.equal(a.status, 200)
  assert.equal(a.headers.get('X-Jell0-Lane'), 'vision')
  assert.equal(a.headers.get('X-Jell0-Routed'), 'workersai/' + DSV41)
  assert.equal(aiCalls[0].id, DSV41)
  assert.deepEqual(aiCalls[0].input.messages[0].content[1], { type: 'image_url', image_url: { url: IMAGE } })
  assert.equal((await a.json()).model, DSV41)

  // flagship lane and glm-5.3 by name: glm-5.3 has no vision, so it is skipped
  for (const model of ['jell0-flagship', 'glm-5.3']) {
    const r = await worker.fetch(call('/v1/chat/completions', { body: { model, messages: msg }, headers: bearer(KV_KEY) }), env)
    assert.equal(r.status, 200)
    assert.equal(aiCalls.at(-1).id, DSV41, model)
  }
  assert.ok(!aiCalls.some(c => c.id === GLM53), 'a model without vision never gets an image')

  // the fast lane with an image starts at gemma (it has vision)
  await worker.fetch(call('/v1/chat/completions', { body: { model: 'jell0-fast', messages: msg }, headers: bearer(KV_KEY) }), env)
  assert.equal(aiCalls.at(-1).id, GEMMA)
})

test('vision: a Claude Code screenshot (Anthropic image block) reaches a vision model as image_url', async () => {
  clearKeyCache()
  const { env, aiCalls } = makeEnv(() => chatJSON({ content: 'It is a login form.' }))
  const body = {
    model: 'claude-sonnet-4-5', max_tokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'text', text: 'What is this?' }] }],
  }
  const r = await worker.fetch(call('/v1/messages', { body, headers: { 'x-api-key': MGR_KEY } }), env)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('X-Jell0-Lane'), 'flagship')
  assert.equal(aiCalls[0].id, DSV41)
  assert.deepEqual(aiCalls[0].input.messages[0].content[0], { type: 'image_url', image_url: { url: IMAGE } })
  const j = await r.json()
  assert.equal(j.content[0].text, 'It is a login form.')
})

// ---------------------------------------------------------------- Claude Code

const CC_TOOLS = [{
  name: 'Read', description: 'Reads a file from the local filesystem.',
  input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
}]
const CC_SYSTEM = [{ type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }]
const CC_FIRST = { role: 'user', content: [{ type: 'text', text: 'What is the name in package.json?', cache_control: { type: 'ephemeral' } }] }

const ccBody = (messages, extra = {}) => ({
  model: 'claude-opus-4-1-20250805',
  max_tokens: 64000,
  system: CC_SYSTEM,
  tools: CC_TOOLS,
  metadata: { user_id: 'e2e' },
  thinking: { type: 'enabled', budget_tokens: 8000 },
  temperature: 1,
  messages,
  ...extra,
})

test('Claude Code: /v1/messages tool_use round trip (JSON), with a Manager key', async () => {
  clearKeyCache()
  const replies = [
    chatJSON({ content: 'Let me read it.', reasoning_content: 'Read the file first.', tool_calls: [{ id: 'call_cc1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } }] }, 'tool_calls'),
    chatJSON({ content: 'The name is jell0-router.' }, 'stop', { prompt_tokens: 90, completion_tokens: 8, total_tokens: 98, prompt_tokens_details: { cached_tokens: 30 } }),
  ]
  const { env, aiCalls, sqls } = makeEnv((id, input, n) => replies[n - 1])

  // turn 1: the model asks for a tool
  const r1 = await worker.fetch(call('/v1/messages?beta=true', { body: ccBody([CC_FIRST]), headers: { 'x-api-key': MGR_KEY, 'anthropic-version': '2023-06-01' } }), env)
  assert.equal(r1.status, 200)
  assert.equal(r1.headers.get('X-Jell0-Lane'), 'flagship')
  assert.equal(r1.headers.get('X-Jell0-Routed'), 'workersai/' + GLM53)
  assert.ok(sqls.length >= 1, 'the Manager key was checked in D1')
  const in1 = aiCalls[0].input
  assert.equal(aiCalls[0].id, GLM53)
  assert.deepEqual(in1.messages[0], { role: 'system', content: 'You are Claude Code.' })
  assert.deepEqual(in1.messages[1], { role: 'user', content: 'What is the name in package.json?' })
  assert.equal(in1.tools[0].function.name, 'Read')
  assert.deepEqual(in1.tools[0].function.parameters, CC_TOOLS[0].input_schema)
  assert.equal(in1.max_tokens, 32768, 'max_tokens is capped')
  assert.equal(in1.reasoning_effort, 'high', 'Anthropic thinking maps to high')
  for (const k of ['metadata', 'thinking', 'system', 'model']) assert.equal(in1[k], undefined, k + ' must not reach Workers AI')

  const m1 = await r1.json()
  assert.equal(m1.type, 'message')
  assert.equal(m1.role, 'assistant')
  assert.equal(m1.model, 'claude-opus-4-1-20250805')
  assert.match(m1.id, /^msg_/)
  assert.equal(m1.stop_reason, 'tool_use')
  assert.deepEqual(m1.content.map(b => b.type), ['thinking', 'text', 'tool_use'])
  const use = m1.content[2]
  assert.deepEqual(use, { type: 'tool_use', id: 'call_cc1', name: 'Read', input: { file_path: 'package.json' } })
  assert.equal(m1.usage.input_tokens, 40)
  assert.equal(m1.usage.output_tokens, 12)

  // turn 2: Claude Code sends the whole assistant turn back plus the tool result
  const turn2 = [CC_FIRST, { role: 'assistant', content: m1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: '{"name":"jell0-router"}' }] }]
  const r2 = await worker.fetch(call('/v1/messages?beta=true', { body: ccBody(turn2), headers: { 'x-api-key': MGR_KEY } }), env)
  assert.equal(r2.status, 200)
  const in2 = aiCalls[1].input.messages
  assert.deepEqual(in2.map(m => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.equal(in2[2].content, 'Let me read it.', 'thinking is not sent back to the model')
  assert.deepEqual(in2[2].tool_calls, [{ id: 'call_cc1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } }])
  assert.deepEqual(in2[3], { role: 'tool', tool_call_id: 'call_cc1', content: '{"name":"jell0-router"}' })

  const m2 = await r2.json()
  assert.equal(m2.stop_reason, 'end_turn')
  assert.deepEqual(m2.content, [{ type: 'text', text: 'The name is jell0-router.' }])
  assert.deepEqual(m2.usage, { input_tokens: 60, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 })
})

test('Claude Code: streaming tool_use answers the exact Anthropic event order', async () => {
  const upstream = () => sse([
    { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Read the file' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: ' first.' } }] },
    { choices: [{ index: 0, delta: { content: 'Let me ' } }] },
    { choices: [{ index: 0, delta: { content: 'read it.' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_cc1', type: 'function', function: { name: 'Read', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"package.json"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 70, completion_tokens: 25, total_tokens: 95 } },
    '[DONE]',
  ])
  const { env, aiCalls } = makeEnv(upstream)
  const r = await worker.fetch(call('/v1/messages?beta=true', { body: ccBody([CC_FIRST], { stream: true }), headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(r.headers.get('X-Jell0-Routed'), 'workersai/' + GLM53)
  assert.equal(aiCalls[0].input.stream, true)

  const evs = anthropicEvents(await r.text())
  assert.deepEqual(shape(evs), [
    'message_start',
    'content_block_start:0:thinking',
    'content_block_delta:0:thinking_delta',
    'content_block_delta:0:thinking_delta',
    'content_block_stop:0',
    'content_block_start:1:text',
    'content_block_delta:1:text_delta',
    'content_block_delta:1:text_delta',
    'content_block_stop:1',
    'content_block_start:2:tool_use',
    'content_block_delta:2:input_json_delta',
    'content_block_delta:2:input_json_delta',
    'content_block_stop:2',
    'message_delta:tool_use',
    'message_stop',
  ])
  const start = evs[0].data.message
  assert.equal(start.model, 'claude-opus-4-1-20250805')
  assert.equal(start.role, 'assistant')
  assert.deepEqual(start.content, [])
  assert.equal(evs.slice(2, 4).map(e => e.data.delta.thinking).join(''), 'Read the file first.')
  assert.equal(evs.slice(6, 8).map(e => e.data.delta.text).join(''), 'Let me read it.')
  assert.deepEqual(evs[9].data.content_block, { type: 'tool_use', id: 'call_cc1', name: 'Read', input: {} })
  // the arguments stream as they arrive, one input_json_delta per piece
  assert.deepEqual(evs.slice(10, 12).map(e => e.data.delta.partial_json), ['{"file_path":', '"package.json"}'])
  assert.deepEqual(JSON.parse(evs.slice(10, 12).map(e => e.data.delta.partial_json).join('')), { file_path: 'package.json' })
  assert.equal(evs[13].data.usage.output_tokens, 25)
  assert.equal(evs[13].data.usage.input_tokens, 70)
})

test('Claude Code: streaming from an older { response } model keeps the same event order', async () => {
  const { env } = makeEnv(() => sse([
    { response: 'Let me ' },
    { response: 'read it.' },
    { response: '', tool_calls: [{ name: 'Read', arguments: { file_path: 'package.json' } }] },
    { response: '', usage: { prompt_tokens: 70, completion_tokens: 25, total_tokens: 95 } },
    '[DONE]',
  ]))
  const r = await worker.fetch(call('/v1/messages', { body: ccBody([CC_FIRST], { stream: true, model: 'glm-5.3' }), headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 200)
  const evs = anthropicEvents(await r.text())
  assert.deepEqual(shape(evs), [
    'message_start',
    'content_block_start:0:text',
    'content_block_delta:0:text_delta',
    'content_block_delta:0:text_delta',
    'content_block_stop:0',
    'content_block_start:1:tool_use',
    'content_block_delta:1:input_json_delta',
    'content_block_stop:1',
    'message_delta:tool_use',
    'message_stop',
  ])
  assert.equal(evs[0].data.message.model, 'glm-5.3')
  assert.match(evs[5].data.content_block.id, /^call_/)
  assert.deepEqual(JSON.parse(evs[6].data.delta.partial_json), { file_path: 'package.json' })
})

test('Claude Code: streaming plain text ends with end_turn; haiku goes to the fast lane', async () => {
  const { env, aiCalls } = makeEnv(() => sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]))
  const r = await worker.fetch(call('/v1/messages', {
    body: { model: 'claude-haiku-4-5-20251001', max_tokens: 512, stream: true, messages: [{ role: 'user', content: 'Title for this chat?' }] },
    headers: bearer(KV_KEY),
  }), env)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('X-Jell0-Lane'), 'fast')
  assert.equal(aiCalls[0].id, GEMMA)
  assert.deepEqual(shape(anthropicEvents(await r.text())), [
    'message_start', 'content_block_start:0:text', 'content_block_delta:0:text_delta', 'content_block_stop:0', 'message_delta:end_turn', 'message_stop',
  ])
})

test('Claude Code: upstream bytes split mid-line and mid-character still stream whole text', async () => {
  const events = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Caf\u00e9 ' } }] },
    { choices: [{ index: 0, delta: { content: 'na\u00efve \u2192 ok' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ].map(e => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n'
  const bytes = enc.encode(events)
  const { env } = makeEnv(() => new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
      c.close()
    },
  }))
  const r = await worker.fetch(call('/v1/messages', { body: ccBody([CC_FIRST], { stream: true, tools: undefined }), headers: bearer(KV_KEY) }), env)
  const evs = anthropicEvents(await r.text())
  const text = evs.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join('')
  assert.equal(text, 'Caf\u00e9 na\u00efve \u2192 ok')
  assert.equal(evs.at(-1).event, 'message_stop')
  assert.equal(evs.at(-2).data.delta.stop_reason, 'end_turn')
})

test('Claude Code: count_tokens answers an estimate and calls no model', async () => {
  clearKeyCache()
  const { env, aiCalls } = makeEnv(() => { throw new Error('no model call expected') })
  const body = { model: 'claude-opus-4-1-20250805', system: CC_SYSTEM, tools: CC_TOOLS, messages: [CC_FIRST] }
  for (const headers of [bearer(KV_KEY), { 'x-api-key': MGR_KEY }]) {
    const r = await worker.fetch(call('/v1/messages/count_tokens?beta=true', { body, headers }), env)
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.deepEqual(Object.keys(j), ['input_tokens'])
    assert.ok(Number.isInteger(j.input_tokens) && j.input_tokens > 10)
  }
  const bigger = await (await worker.fetch(call('/v1/messages/count_tokens', {
    body: { ...body, messages: [{ role: 'user', content: 'x'.repeat(4000) }] }, headers: bearer(KV_KEY),
  }), env)).json()
  assert.ok(bigger.input_tokens >= 1000)
  const no = await worker.fetch(call('/v1/messages/count_tokens', { body }), env)
  assert.equal(no.status, 401)
  assert.equal((await no.json()).type, 'error')
  assert.equal(aiCalls.length, 0)
})

// ---------------------------------------------------------------- fallback

const busy = () => Object.assign(new Error('5028: Capacity temporarily exceeded, please try again.'), { status: 429 })

test('fallback: the first model throws, the next one answers (JSON, OpenAI)', async () => {
  const { env, aiCalls } = makeEnv(id => {
    if (id === GLM53) throw busy()
    return chatJSON({ content: 'from deepseek' })
  })
  const r = await worker.fetch(call('/v1/chat/completions', { body: { model: 'jell0-flagship', messages: [{ role: 'user', content: 'hi' }] }, headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 200)
  assert.deepEqual(aiCalls.map(c => c.id), [GLM53, DSV41])
  assert.equal(r.headers.get('X-Jell0-Routed'), 'workersai/' + DSV41 + ' (fallback)')
  assert.equal(r.headers.get('X-Jell0-Lane'), 'flagship')
  const j = await r.json()
  assert.equal(j.model, DSV41)
  assert.equal(j.choices[0].message.content, 'from deepseek')
})

test('fallback: thrown error and error answer both move on (streaming, OpenAI and Anthropic)', async () => {
  const ai = id => {
    if (id === GLM53) throw busy()
    if (id === DSV41) return { success: false, errors: [{ code: 3040, message: 'Capacity temporarily exceeded' }] }
    return sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: 'from qwen' }, finish_reason: 'stop' }] }, '[DONE]'])
  }
  const { env, aiCalls } = makeEnv(ai)
  const o = await worker.fetch(call('/v1/chat/completions', { body: opencodeBody({ tools: undefined, tool_choice: undefined }), headers: bearer(KV_KEY) }), env)
  assert.equal(o.status, 200)
  assert.equal(o.headers.get('X-Jell0-Routed'), 'workersai/' + QWEN + ' (fallback)')
  const evs = openaiEvents(await o.text())
  assert.equal(evs.at(-1), '[DONE]')
  assert.ok(evs.slice(0, -1).every(c => c.model === QWEN))
  assert.deepEqual(aiCalls.map(c => c.id), TOP)

  const a = await worker.fetch(call('/v1/messages', { body: ccBody([CC_FIRST], { stream: true, tools: undefined }), headers: bearer(KV_KEY) }), env)
  assert.equal(a.status, 200)
  assert.equal(a.headers.get('X-Jell0-Routed'), 'workersai/' + QWEN + ' (fallback)')
  const aev = anthropicEvents(await a.text())
  assert.equal(aev.at(-1).event, 'message_stop')
  assert.equal(aev.find(e => e.event === 'content_block_delta').data.delta.text, 'from qwen')
})

test('fallback: a stream whose first event is an error moves on to the next model', async () => {
  const { env, aiCalls } = makeEnv(id => id === GLM53
    ? sse([{ error: { message: 'model is gone', code: 5028 } }])
    : sse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']))
  const r = await worker.fetch(call('/v1/chat/completions', { body: opencodeBody({ tools: undefined }), headers: bearer(KV_KEY) }), env)
  assert.equal(r.status, 200)
  assert.deepEqual(aiCalls.map(c => c.id), [GLM53, DSV41])
  assert.match(await r.text(), /"content":"ok"/)
})

test('fallback: an error after the stream started becomes an error event (no made-up reply)', async () => {
  const { env } = makeEnv(() => sse([
    { choices: [{ index: 0, delta: { content: 'Part' } }] },
    { error: { message: 'Capacity temporarily exceeded' } },
  ]))
  const o = await worker.fetch(call('/v1/chat/completions', { body: opencodeBody({ tools: undefined }), headers: bearer(KV_KEY) }), env)
  const evs = openaiEvents(await o.text())
  assert.equal(evs.at(-1).error.type, 'server_error')
  assert.ok(!evs.includes('[DONE]'))

  const a = await worker.fetch(call('/v1/messages', { body: ccBody([CC_FIRST], { stream: true }), headers: bearer(KV_KEY) }), env)
  const aev = anthropicEvents(await a.text())
  assert.deepEqual(shape(aev), ['message_start', 'content_block_start:0:text', 'content_block_delta:0:text_delta', 'content_block_stop:0', 'error'])
  assert.equal(aev.at(-1).data.error.type, 'overloaded_error')
})

test('fallback: when every model is busy the answer is an honest 429; other failures are a 503', async () => {
  const { env, aiCalls } = makeEnv(() => { throw busy() })
  const o = await worker.fetch(call('/v1/chat/completions', { body: opencodeBody(), headers: bearer(KV_KEY) }), env)
  assert.equal(o.status, 429)
  assert.equal(o.headers.get('X-Jell0-Routed'), 'none')
  const j = await o.json()
  assert.equal(j.error.code, 'rate_limit_exceeded')
  assert.match(j.error.message, /Capacity temporarily exceeded/)
  assert.deepEqual(aiCalls.map(c => c.id), TOP)

  const a = await worker.fetch(call('/v1/messages', { body: ccBody([CC_FIRST], { stream: true }), headers: bearer(KV_KEY) }), env)
  assert.equal(a.status, 429)
  assert.match(a.headers.get('content-type'), /application\/json/)
  const aj = await a.json()
  assert.equal(aj.type, 'error')
  assert.equal(aj.error.type, 'rate_limit_error')

  const { env: env2 } = makeEnv(n => { throw new Error('upstream 500') })
  const o2 = await worker.fetch(call('/v1/chat/completions', { body: opencodeBody(), headers: bearer(KV_KEY) }), env2)
  assert.equal(o2.status, 503)
  const j2 = await o2.json()
  assert.equal(j2.error.type, 'server_error')
  assert.equal(j2.error.code, 'all_models_failed')
  const a2 = await worker.fetch(call('/v1/messages', { body: ccBody([CC_FIRST], { stream: true }), headers: bearer(KV_KEY) }), env2)
  assert.equal(a2.status, 503)
  assert.equal((await a2.json()).error.type, 'api_error')
})

// ---------------------------------------------------------------- 401 and 404

test('401: no key, a wrong key, a key without ai_models, and the admin token never run a model', async () => {
  clearKeyCache()
  const { env, aiCalls } = makeEnv(() => chatJSON({ content: 'should not run' }))
  const bad = [{}, bearer('e2e-wrong-key-zzzzzzzzzzzz'), { 'x-api-key': 'e2e-wrong' }, bearer(MGR_NO_PERM), bearer(ADMIN), { 'x-api-key': ADMIN }]
  for (const headers of bad) {
    const o = await worker.fetch(call('/v1/chat/completions', { body: opencodeBody(), headers }), env)
    assert.equal(o.status, 401)
    const oj = await o.json()
    assert.equal(oj.error.code, 'invalid_api_key')
    assert.equal(typeof oj.error.message, 'string')

    const a = await worker.fetch(call('/v1/messages', { body: ccBody([CC_FIRST]), headers }), env)
    assert.equal(a.status, 401)
    assert.deepEqual(Object.keys(await a.json()).sort(), ['error', 'type'])
  }
  assert.equal(aiCalls.length, 0)

  // admin routes take only the admin token
  for (const headers of [{}, bearer(KV_KEY), bearer(MGR_KEY)]) {
    assert.equal((await worker.fetch(call('/api/jell0/keys', { body: { label: 'x' }, headers }), env)).status, 401)
    assert.equal((await worker.fetch(call('/api/jell0/session', { method: 'GET', headers }), env)).status, 401)
  }
})

test('admin to client: a key the admin makes works for OpenCode and stops when deleted', async () => {
  const { env } = makeEnv(() => chatJSON({ content: 'hi' }))
  const made = await (await worker.fetch(call('/api/jell0/keys', { body: { label: 'box' }, headers: bearer(ADMIN) }), env)).json()
  const use = () => worker.fetch(call('/v1/chat/completions', { body: { model: 'jell0', messages: [{ role: 'user', content: 'hi' }] }, headers: bearer(made.key) }), env)
  assert.equal((await use()).status, 200)
  await worker.fetch(call('/api/jell0/keys?id=' + made.id, { method: 'DELETE', headers: bearer(ADMIN) }), env)
  assert.equal((await use()).status, 401)
})

test('404: removed provider, console and login endpoints, and wrong methods', async () => {
  const { env, aiCalls } = makeEnv(() => chatJSON({ content: 'no' }))
  const paths = [
    ['GET', '/api/jell0/discover'], ['GET', '/api/jell0/providers'], ['POST', '/api/jell0/providers'],
    ['POST', '/api/jell0/connect'], ['POST', '/api/jell0/login'], ['GET', '/console'], ['GET', '/v1/messages'],
    ['GET', '/v1/chat/completions'], ['PUT', '/api/jell0/keys'], ['POST', '/v1/models'], ['GET', '/v1/modelsx'],
  ]
  for (const [method, path] of paths) {
    for (const headers of [{}, bearer(KV_KEY), bearer(ADMIN)]) {
      const r = await worker.fetch(call(path, { method, headers, body: method === 'GET' ? undefined : {} }), env)
      assert.equal(r.status, 404, method + ' ' + path)
      assert.equal((await r.json()).error.code, 'not_found')
    }
  }
  assert.equal(aiCalls.length, 0)

  // what stays open with no key
  const models = await (await worker.fetch(call('/v1/models', { method: 'GET' }), env)).json()
  const ids = models.data.map(m => m.id)
  for (const id of ['jell0', 'jell0-flagship', 'jell0-max', 'jell0-glm', 'glm-5.3', GLM53, 'deepseek-v4.1-flash', 'qwen3.8-27b']) assert.ok(ids.includes(id), id)
  assert.equal((await worker.fetch(call('/health', { method: 'GET' }), env)).status, 200)
  const sel = await (await worker.fetch(call('/select?prompt=fix+this+python+bug&pref=jell0', { method: 'GET' }), env)).json()
  assert.equal(sel.lane, 'coding')
  assert.deepEqual(sel.chain, [DSV41, QWEN, GEMMA]) // the smart lane never runs glm-5.3
})
