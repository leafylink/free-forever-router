// Tests for jell0/src/anthropic.js. Run from the repo root:
//   node --test jell0/test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  openAISSEToAnthropicSSE,
  countTokens,
  anthropicError,
} from '../src/anthropic.js'

// ---------------------------------------------------------------- helpers

const enc = new TextEncoder()

// Upstream OpenAI SSE as a byte stream; each string is one network chunk.
function upstreamOf(chunks, { failAfter = false } = {}) {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
      else if (failAfter) controller.error(new Error('socket reset'))
      else controller.close()
    },
  })
}

const sse = obj => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`
const delta = (d, extra = {}) => sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: null }], ...extra })
const finishChunk = reason => sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] })

// Parse Anthropic SSE text into [{ event, data }], checking the wire format.
function parseSSE(text) {
  assert.ok(text.endsWith('\n\n'), 'stream ends on an event boundary')
  return text.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n')
    assert.equal(lines.length, 2, `two lines per event: ${block}`)
    assert.ok(lines[0].startsWith('event: '))
    assert.ok(lines[1].startsWith('data: '))
    const event = lines[0].slice(7)
    const data = JSON.parse(lines[1].slice(6))
    assert.equal(data.type, event, 'data.type matches the event name')
    return { event, data }
  })
}

async function collect(stream) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  return text + dec.decode()
}

async function translate(chunks, opts) {
  return parseSSE(await collect(openAISSEToAnthropicSSE(upstreamOf(chunks, opts), 'glm-5.3')))
}

// Invariants every translated stream must hold.
function checkInvariants(events, { error = false } = {}) {
  assert.equal(events[0].event, 'message_start')
  assert.equal(events[0].data.message.model, 'glm-5.3')
  assert.equal(events[0].data.message.role, 'assistant')
  assert.match(events[0].data.message.id, /^msg_/)
  let next = 0
  let open = null
  for (const { event, data } of events.slice(1)) {
    if (event === 'content_block_start') {
      assert.equal(open, null, 'previous block stopped before a new one starts')
      assert.equal(data.index, next, 'block indexes increase by one from 0')
      open = data.index
      next++
    } else if (event === 'content_block_delta') {
      assert.equal(data.index, open, 'delta goes to the open block')
    } else if (event === 'content_block_stop') {
      assert.equal(data.index, open, 'stop closes the open block')
      open = null
    } else if (event === 'message_delta' || event === 'message_stop' || event === 'error') {
      assert.equal(open, null, `every started block is stopped before ${event}`)
    }
  }
  const last = events[events.length - 1].event
  if (error) {
    assert.equal(last, 'error')
    assert.ok(!events.some(e => e.event === 'message_stop'))
  } else {
    assert.equal(last, 'message_stop', 'message_stop is last')
    assert.equal(events[events.length - 2].event, 'message_delta')
    assert.equal(events.filter(e => e.event === 'message_stop').length, 1)
  }
}

// Rebuild the final content blocks the way an SDK accumulator would.
function blocksOf(events) {
  const blocks = []
  for (const { event, data } of events) {
    if (event === 'content_block_start') blocks[data.index] = { ...data.content_block, _json: '' }
    if (event === 'content_block_delta') {
      const b = blocks[data.index]
      const d = data.delta
      if (d.type === 'text_delta') b.text += d.text
      if (d.type === 'thinking_delta') b.thinking += d.thinking
      if (d.type === 'input_json_delta') b._json += d.partial_json
    }
  }
  return blocks.map(({ _json, ...b }) => (b.type === 'tool_use' ? { ...b, input: _json ? JSON.parse(_json) : {} } : b))
}

const messageDelta = events => events.find(e => e.event === 'message_delta').data

// ---------------------------------------------------------------- anthropicToOpenAI

test('request: plain text, model, sampling fields', () => {
  const r = anthropicToOpenAI({
    model: 'claude-opus-5-5', max_tokens: 1024, temperature: 0.2, top_p: 0.9, top_k: 40,
    metadata: { user_id: 'u1' },
    messages: [{ role: 'user', content: 'Hello' }],
  })
  assert.equal(r.requestedModel, 'claude-opus-5-5')
  assert.equal(r.stream, false)
  assert.deepEqual(r.openai, { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 1024, temperature: 0.2, top_p: 0.9 })
  assert.ok(!('model' in r.openai))
})

test('request: system as a string', () => {
  const r = anthropicToOpenAI({ model: 'glm', system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] })
  assert.deepEqual(r.openai.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }])
})

test('request: system blocks with cache_control are joined and cache_control is dropped', () => {
  const r = anthropicToOpenAI({
    model: 'glm',
    system: [
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'Project rules here.', cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Go', cache_control: { type: 'ephemeral' } }] }],
  })
  assert.deepEqual(r.openai.messages[0], { role: 'system', content: 'You are Claude Code.\n\nProject rules here.' })
  assert.deepEqual(r.openai.messages[1], { role: 'user', content: 'Go' })
  assert.ok(!JSON.stringify(r.openai).includes('cache_control'))
})

test('request: empty system is left out', () => {
  const r = anthropicToOpenAI({ model: 'glm', system: [], messages: [{ role: 'user', content: 'Hi' }] })
  assert.equal(r.openai.messages.length, 1)
})

test('request: multi-turn with tool_use and tool_result (string, blocks, is_error)', () => {
  const r = anthropicToOpenAI({
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: 'Weather in Paris and Rome? Also list files.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should call tools.', signature: 'sig' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
          { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'Rome' } },
          { type: 'tool_use', id: 'toolu_3', name: 'ls', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '18C sunny' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: '21C' }, { type: 'text', text: 'clear' }] },
          { type: 'tool_result', tool_use_id: 'toolu_3', content: 'permission denied', is_error: true },
          { type: 'text', text: 'Thanks, summarize.' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_4', name: 'ls', input: { path: '/' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_4' }] },
    ],
  })
  assert.deepEqual(r.openai.messages, [
    { role: 'user', content: 'Weather in Paris and Rome? Also list files.' },
    {
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        { id: 'toolu_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } },
        { id: 'toolu_3', type: 'function', function: { name: 'ls', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'toolu_1', content: '18C sunny' },
    { role: 'tool', tool_call_id: 'toolu_2', content: '21C\nclear' },
    { role: 'tool', tool_call_id: 'toolu_3', content: 'Error: permission denied' },
    { role: 'user', content: 'Thanks, summarize.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_4', type: 'function', function: { name: 'ls', arguments: '{"path":"/"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_4', content: '(no output)' },
  ])
  assert.ok(!JSON.stringify(r.openai).includes('I should call tools'), 'thinking is not sent back')
})

test('request: images as base64 and url become image_url parts', () => {
  const r = anthropicToOpenAI({
    model: 'qwen',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
        { type: 'text', text: 'What is in these?' },
      ],
    }],
  })
  assert.deepEqual(r.openai.messages, [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      { type: 'text', text: 'What is in these?' },
    ],
  }])
})

test('request: an image inside a tool_result moves to the following user message', () => {
  const r = anthropicToOpenAI({
    model: 'qwen',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] }] },
    ],
  })
  assert.deepEqual(r.openai.messages.slice(1), [
    { role: 'tool', tool_call_id: 't1', content: '(image output follows)' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
  ])
})

test('request: text documents pass, PDFs are replaced by a note', () => {
  const r = anthropicToOpenAI({
    model: 'glm',
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'doc body' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } },
      ],
    }],
  })
  assert.equal(r.openai.messages[0].content, 'doc body\n\n[document omitted: jell0 only passes text documents]')
})

const TOOLS = [
  { name: 'get_weather', description: 'Weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, cache_control: { type: 'ephemeral' } },
  { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
]

test('request: tools become functions; schema-less server tools are dropped', () => {
  const r = anthropicToOpenAI({ model: 'glm', tools: TOOLS, messages: [{ role: 'user', content: 'x' }] })
  assert.deepEqual(r.openai.tools, [{
    type: 'function',
    function: { name: 'get_weather', description: 'Weather for a city', parameters: TOOLS[0].input_schema },
  }])
  assert.ok(!('tool_choice' in r.openai))
})

test('request: tool_choice auto, any, tool, none', () => {
  const choose = tool_choice => anthropicToOpenAI({ model: 'glm', tools: TOOLS, tool_choice, messages: [{ role: 'user', content: 'x' }] }).openai
  assert.equal(choose({ type: 'auto' }).tool_choice, 'auto')
  assert.equal(choose({ type: 'any' }).tool_choice, 'required')
  assert.deepEqual(choose({ type: 'tool', name: 'get_weather' }).tool_choice, { type: 'function', function: { name: 'get_weather' } })
  assert.equal(choose({ type: 'none' }).tool_choice, 'none')
  assert.equal(choose({ type: 'auto', disable_parallel_tool_use: true }).parallel_tool_calls, false)
  assert.ok(!('parallel_tool_calls' in choose({ type: 'auto' })))
})

test('request: tool_choice without tools is dropped', () => {
  const r = anthropicToOpenAI({ model: 'glm', tool_choice: { type: 'any' }, messages: [{ role: 'user', content: 'x' }] })
  assert.ok(!('tool_choice' in r.openai))
  assert.ok(!('tools' in r.openai))
})

test('request: stop_sequences become stop', () => {
  const r = anthropicToOpenAI({ model: 'glm', stop_sequences: ['END', '###'], messages: [{ role: 'user', content: 'x' }] })
  assert.deepEqual(r.openai.stop, ['END', '###'])
  const none = anthropicToOpenAI({ model: 'glm', stop_sequences: [], messages: [{ role: 'user', content: 'x' }] })
  assert.ok(!('stop' in none.openai))
})

test('request: thinking enabled or adaptive maps to reasoning_effort high, disabled to none, absent to nothing', () => {
  const effort = thinking => anthropicToOpenAI({ model: 'glm', thinking, messages: [{ role: 'user', content: 'x' }] }).openai.reasoning_effort
  assert.equal(effort({ type: 'enabled', budget_tokens: 4096 }), 'high')
  assert.equal(effort({ type: 'adaptive' }), 'high')
  assert.equal(effort({ type: 'disabled' }), 'none')
  assert.equal(effort(undefined), undefined)
})

test('request: stream flag', () => {
  const r = anthropicToOpenAI({ model: 'glm', stream: true, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(r.stream, true)
  assert.equal(r.openai.stream, true)
})

test('request: mid-conversation system message and structured output format', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } }
  const r = anthropicToOpenAI({
    model: 'glm',
    output_config: { format: { type: 'json_schema', schema }, effort: 'high' },
    messages: [
      { role: 'user', content: 'x' },
      { role: 'system', content: 'Answer in JSON.' },
      { role: 'system', content: [] },
    ],
  })
  assert.deepEqual(r.openai.messages, [{ role: 'user', content: 'x' }, { role: 'system', content: 'Answer in JSON.' }])
  assert.deepEqual(r.openai.response_format, { type: 'json_schema', json_schema: { name: 'output', schema } })
})

test('request: missing or odd input does not throw', () => {
  assert.deepEqual(anthropicToOpenAI({}).openai, { messages: [] })
  assert.equal(anthropicToOpenAI({ model: 7 }).requestedModel, '')
  assert.deepEqual(anthropicToOpenAI({ messages: [{ role: 'user', content: [] }] }).openai.messages, [{ role: 'user', content: '' }])
})

// ---------------------------------------------------------------- openAIToAnthropic

const chat = (message, finish_reason = 'stop', usage) => ({
  id: 'chatcmpl-abc123', object: 'chat.completion', created: 1, model: '@cf/zai-org/glm-5.3',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }],
  usage,
})

test('reply: text with usage (cached tokens split out)', () => {
  const m = openAIToAnthropic(chat({ content: 'Hello there' }, 'stop', { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } }), 'claude-opus-5-5')
  assert.deepEqual(m, {
    id: 'msg_abc123', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'Hello there' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 60, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 },
  })
})

test('reply: tool_calls with good arguments become tool_use blocks', () => {
  const m = openAIToAnthropic(chat({
    content: 'Let me check.',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: { city: 'Rome' } } },
    ],
  }, 'tool_calls'), 'glm-5.3')
  assert.deepEqual(m.content, [
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
    { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'Rome' } },
  ])
  assert.equal(m.stop_reason, 'tool_use')
})

test('reply: malformed, empty, double-encoded and missing-id tool arguments', () => {
  const m = openAIToAnthropic(chat({
    content: null,
    tool_calls: [
      { id: 'c1', function: { name: 'a', arguments: '{"city": "Par' } },
      { id: 'c2', function: { name: 'b', arguments: '' } },
      { id: 'c3', function: { name: 'c', arguments: JSON.stringify('{"x":1}') } },
      { id: 'c4', function: { name: 'd', arguments: '[1,2]' } },
      { function: { name: 'e', arguments: '{}' } },
    ],
  }, 'stop'), 'glm-5.3')
  assert.equal(m.content.length, 5, 'no text block when content is null')
  assert.deepEqual(m.content[0].input, { _raw_arguments: '{"city": "Par' })
  assert.deepEqual(m.content[1].input, {})
  assert.deepEqual(m.content[2].input, { x: 1 })
  assert.deepEqual(m.content[3].input, { _raw_arguments: '[1,2]' })
  assert.match(m.content[4].id, /^toolu_[0-9a-f]{32}$/)
  assert.equal(m.stop_reason, 'tool_use', 'tool calls win over a "stop" finish_reason')
})

test('reply: reasoning_content becomes a thinking block before the text', () => {
  const m = openAIToAnthropic(chat({ reasoning_content: 'Think first.', content: 'Answer.' }), 'glm-5.3')
  assert.deepEqual(m.content, [
    { type: 'thinking', thinking: 'Think first.', signature: '' },
    { type: 'text', text: 'Answer.' },
  ])
  const alt = openAIToAnthropic(chat({ reasoning: 'Also here.', content: 'Ok.' }), 'x')
  assert.equal(alt.content[0].thinking, 'Also here.')
})

test('reply: finish_reason mapping', () => {
  const stop = (finish, msg = { content: 'x' }) => openAIToAnthropic(chat(msg, finish), 'm').stop_reason
  assert.equal(stop('stop'), 'end_turn')
  assert.equal(stop('length'), 'max_tokens')
  assert.equal(stop('content_filter'), 'refusal')
  assert.equal(stop(null), 'end_turn')
  assert.equal(stop('tool_calls', { content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }), 'tool_use')
  assert.equal(stop('tool_calls', { content: 'no calls came back' }), 'end_turn', 'no tool_use stop without a tool_use block')
  assert.equal(stop('length', { content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"a"' } }] }), 'max_tokens')
})

test('reply: empty answer still has one text block; missing id and usage are filled', () => {
  const m = openAIToAnthropic({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, 'm')
  assert.deepEqual(m.content, [{ type: 'text', text: '' }])
  assert.match(m.id, /^msg_[0-9a-f]{32}$/)
  assert.deepEqual(m.usage, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
  assert.equal(openAIToAnthropic({}, 'm').content[0].text, '')
})

// ---------------------------------------------------------------- streaming

test('stream: text, exact event sequence and wire format', async () => {
  const events = await translate([
    delta({ role: 'assistant', content: '' }),
    delta({ content: 'Hel' }),
    delta({ content: 'lo' }),
    finishChunk('stop'),
    sse({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }),
    sse('[DONE]'),
  ])
  checkInvariants(events)
  assert.deepEqual(events.map(e => e.event), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ])
  assert.deepEqual(events[0].data.message.content, [])
  assert.equal(events[0].data.message.stop_reason, null)
  assert.deepEqual(events[1].data, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  assert.deepEqual(events[2].data, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } })
  assert.deepEqual(events[5].data, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: 12, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })
  assert.deepEqual(events[6].data, { type: 'message_stop' })
})

test('stream: reasoning then text gives a thinking block then a text block', async () => {
  const events = await translate([
    delta({ reasoning_content: 'Let me ' }),
    delta({ reasoning_content: 'think.' }),
    delta({ content: 'Done.' }),
    finishChunk('stop'),
    sse('[DONE]'),
  ])
  checkInvariants(events)
  assert.deepEqual(events[1].data.content_block, { type: 'thinking', thinking: '', signature: '' })
  assert.equal(events[2].data.delta.type, 'thinking_delta')
  assert.deepEqual(blocksOf(events), [
    { type: 'thinking', thinking: 'Let me think.', signature: '' },
    { type: 'text', text: 'Done.' },
  ])
})

test('stream: a tool call split over chunks', async () => {
  const events = await translate([
    delta({ content: 'Checking.' }),
    delta({ tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'ty": "Paris"}' } }] }),
    finishChunk('tool_calls'),
    sse('[DONE]'),
  ])
  checkInvariants(events)
  assert.deepEqual(blocksOf(events), [
    { type: 'text', text: 'Checking.' },
    { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: 'Paris' } },
  ])
  const start = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
  assert.deepEqual(start.data.content_block.input, {})
  assert.equal(messageDelta(events).delta.stop_reason, 'tool_use')
})

test('stream: two parallel tool calls, one after the other (index 0 then 1)', async () => {
  const events = await translate([
    delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read', arguments: '{"path":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'read', arguments: '{"path":"b.txt"}' } }] }),
    finishChunk('tool_calls'),
    sse('[DONE]'),
  ])
  checkInvariants(events)
  assert.deepEqual(blocksOf(events), [
    { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } },
    { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.txt' } },
  ])
})

test('stream: a piece for a tool call whose block already closed ends in an error event, not a broken call', async () => {
  const events = await translate([
    delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read', arguments: '{"path":' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'read', arguments: '{"path":"b.txt"}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
    finishChunk('tool_calls'),
    sse('[DONE]'),
  ])
  checkInvariants(events, { error: true })
  assert.match(events.at(-1).data.error.message, /interleaved/)
})

test('stream: tool calls without index, empty, held and malformed arguments', async () => {
  const events = await translate([
    delta({ tool_calls: [{ id: 'x1', function: { name: 'ls', arguments: '' } }, { id: 'x2', function: { name: 'cat', arguments: '[1,2]' } }] }),
    delta({ tool_calls: [{ id: 'x3', function: { name: 'grep', arguments: JSON.stringify('{"q":"a"}') } }] }),
    delta({ tool_calls: [{ id: 'x4', function: { name: 'cut', arguments: '{"f":' } }] }),
    sse('[DONE]'),
  ])
  checkInvariants(events)
  const deltas = events.filter(e => e.event === 'content_block_delta')
  // empty arguments send no json delta; arguments that do not start as a JSON
  // object are held and sent parsed; a live object is passed through as sent
  assert.deepEqual(deltas.map(e => [e.data.index, e.data.delta.partial_json]), [
    [1, '{"_raw_arguments":"[1,2]"}'],
    [2, '{"q":"a"}'],
    [3, '{"f":'],
  ])
  const starts = events.filter(e => e.event === 'content_block_start').map(e => e.data.content_block)
  assert.deepEqual(starts.map(b => [b.id, b.name]), [['x1', 'ls'], ['x2', 'cat'], ['x3', 'grep'], ['x4', 'cut']])
  assert.equal(messageDelta(events).delta.stop_reason, 'tool_use')
})

test('stream: usage in the last chunk, with cached tokens', async () => {
  const events = await translate([
    delta({ content: 'Hi' }),
    finishChunk('length'),
    sse({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 500, completion_tokens: 32, prompt_tokens_details: { cached_tokens: 200 } } }),
    sse('[DONE]'),
  ])
  checkInvariants(events)
  assert.deepEqual(messageDelta(events), {
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens', stop_sequence: null },
    usage: { input_tokens: 300, output_tokens: 32, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 },
  })
})

test('stream: [DONE] ends it; anything after is ignored', async () => {
  const events = await translate([delta({ content: 'A' }), sse('[DONE]'), delta({ content: 'B' })])
  checkInvariants(events)
  assert.deepEqual(blocksOf(events), [{ type: 'text', text: 'A' }])
})

test('stream: an error object mid-stream becomes an Anthropic error event, then close', async () => {
  const events = await translate([
    delta({ content: 'Part' }),
    sse({ error: { message: 'Capacity temporarily exceeded', type: 'server_error', code: 3040 } }),
    delta({ content: 'never sent' }),
  ])
  checkInvariants(events, { error: true })
  assert.deepEqual(events.map(e => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'error'])
  assert.deepEqual(events[4].data, { type: 'error', error: { type: 'overloaded_error', message: 'Capacity temporarily exceeded' } })
})

test('stream: error types for rate limits, plain strings and unknown errors', async () => {
  const errOf = async e => (await translate([sse({ error: e })])).at(-1).data.error
  assert.equal((await errOf({ message: 'slow down', code: 429 })).type, 'rate_limit_error')
  assert.deepEqual(await errOf('model exploded'), { type: 'api_error', message: 'model exploded' })
  assert.deepEqual(await errOf({}), { type: 'api_error', message: 'Upstream model stream failed' })
})

test('stream: an upstream read failure becomes an error event', async () => {
  const events = await translate([delta({ content: 'Hi' })], { failAfter: true })
  checkInvariants(events, { error: true })
  assert.deepEqual(events.at(-1).data.error, { type: 'api_error', message: 'socket reset' })
})

test('stream: ending without [DONE] still finishes cleanly', async () => {
  const events = await translate([delta({ content: 'Short' }), finishChunk('stop')])
  checkInvariants(events)
  assert.equal(messageDelta(events).delta.stop_reason, 'end_turn')
  assert.deepEqual(blocksOf(events), [{ type: 'text', text: 'Short' }])
})

test('stream: last line without a trailing newline is still read', async () => {
  const events = await translate([delta({ content: 'A' }), 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'B' } }] })])
  checkInvariants(events)
  assert.deepEqual(blocksOf(events), [{ type: 'text', text: 'AB' }])
})

test('stream: lines and multi-byte characters split across network chunks, CRLF, comments', async () => {
  const whole = ': keep-alive\r\n\r\n' + delta({ content: 'café \u{1F600}' }).replace(/\n/g, '\r\n') + sse('[DONE]')
  const bytes = enc.encode(whole)
  const upstream = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3))
      c.close()
    },
  })
  const events = parseSSE(await collect(openAISSEToAnthropicSSE(upstream, 'glm-5.3')))
  checkInvariants(events)
  assert.deepEqual(blocksOf(events), [{ type: 'text', text: 'café \u{1F600}' }])
})

test('stream: many chunks in a row that produce no output do not stall the reader', async () => {
  const quiet = Array.from({ length: 6 }, () => ': keep-alive\n\n')
  const run = translate([delta({ content: 'A' }), ...quiet, finishChunk('stop'), ...quiet, sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), ...quiet, sse('[DONE]')])
  let timer
  const stalled = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stream stalled')), 1000) })
  const events = await Promise.race([run, stalled]).finally(() => clearTimeout(timer))
  checkInvariants(events)
  assert.deepEqual(blocksOf(events), [{ type: 'text', text: 'A' }])
})

test('stream: empty upstream gives an empty text block and a clean finish', async () => {
  const events = await translate([sse('[DONE]')])
  checkInvariants(events)
  assert.deepEqual(blocksOf(events), [{ type: 'text', text: '' }])
  assert.equal(messageDelta(events).delta.stop_reason, 'end_turn')
})

test('stream: real passthrough, text arrives before the upstream finishes', async () => {
  let push
  const upstream = new ReadableStream({ start(c) { push = c } })
  const reader = openAISSEToAnthropicSSE(upstream, 'glm-5.3').getReader()
  const dec = new TextDecoder()
  push.enqueue(enc.encode(delta({ content: 'early' })))
  let seen = ''
  while (!seen.includes('text_delta')) {
    const { value, done } = await reader.read()
    assert.ok(!done, 'stream must not end before upstream')
    seen += dec.decode(value, { stream: true })
  }
  assert.ok(seen.includes('"early"'))
  push.enqueue(enc.encode(sse('[DONE]')))
  push.close()
  let rest = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    rest += dec.decode(value, { stream: true })
  }
  checkInvariants(parseSSE(seen + rest))
})

test('stream: cancelling the output cancels the upstream', async () => {
  let cancelled = false
  const upstream = new ReadableStream({ pull() {}, cancel() { cancelled = true } })
  const reader = openAISSEToAnthropicSSE(upstream, 'glm-5.3').getReader()
  await reader.read() // message_start
  await reader.cancel('client went away')
  assert.equal(cancelled, true)
})

test('stream: message_start goes out before any upstream data', async () => {
  const upstream = new ReadableStream({ pull() {} }) // never sends
  const reader = openAISSEToAnthropicSSE(upstream, 'glm-5.3').getReader()
  const { value } = await reader.read()
  const events = parseSSE(new TextDecoder().decode(value))
  assert.equal(events[0].event, 'message_start')
  await reader.cancel()
})

// ---------------------------------------------------------------- countTokens and errors

test('countTokens: grows with text, images cost a flat amount, signatures ignored', () => {
  const base = countTokens({ messages: [{ role: 'user', content: 'hi' }] }).input_tokens
  assert.ok(Number.isInteger(base) && base >= 1)
  const longer = countTokens({ system: 'x'.repeat(4000), messages: [{ role: 'user', content: 'hi' }] }).input_tokens
  assert.ok(longer - base >= 990 && longer - base <= 1010, `about 1000 more tokens, got ${longer - base}`)
  const img = data => countTokens({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] }).input_tokens
  assert.equal(img('A'.repeat(10)), img('A'.repeat(400000)), 'image bytes are not counted as text')
  assert.ok(img('A') >= 1600)
  const sig = s => countTokens({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'a', signature: s }] }] }).input_tokens
  assert.equal(sig('x'), sig('x'.repeat(10000)))
  const withTools = countTokens({ tools: TOOLS, messages: [{ role: 'user', content: 'hi' }] }).input_tokens
  assert.ok(withTools > base)
  assert.deepEqual(countTokens({}), { input_tokens: 1 })
})

test('anthropicError: status, JSON content type, Anthropic error body', async () => {
  const res = anthropicError(401, 'authentication_error', 'Invalid API key')
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.deepEqual(await res.json(), { type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } })
})
