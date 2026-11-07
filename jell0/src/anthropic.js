// Anthropic Messages API <-> OpenAI Chat Completions translation for jell0.
// Pure functions: no env, no network, no secrets. The /v1/messages routes use
// these so Claude Code can talk to the Cloudflare models through jell0.

const IMAGE_TOKENS = 1600 // rough token cost of one image, used by countTokens
const PING_MS = 15000 // a ping event after this long with nothing else to send
const PING_EVENT = 'event: ping\ndata: {"type":"ping"}\n\n'

// ---------------------------------------------------------------- request

// Anthropic Messages request body -> { openai, requestedModel, stream }.
// openai is a Chat Completions body without `model`; the router picks the model.
export function anthropicToOpenAI(body = {}) {
  const messages = []
  const system = textOf(withoutAttribution(body.system))
  if (system) messages.push({ role: 'system', content: system })
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'system') {
      const t = textOf(m.content)
      if (t) messages.push({ role: 'system', content: t })
    } else if (m.role === 'assistant') {
      messages.push(assistantMessage(m.content))
    } else {
      messages.push(...userMessages(m.content))
    }
  }

  const openai = { messages }
  if (body.max_tokens != null) openai.max_tokens = body.max_tokens
  if (body.temperature != null) openai.temperature = body.temperature
  if (body.top_p != null) openai.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) openai.stop = body.stop_sequences

  // Only tools with a schema can be described to an open model. Anthropic
  // server tools (web search, code execution...) have none and are dropped.
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter(t => t && t.name && t.input_schema)
    .map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema } }))
  if (tools.length) {
    openai.tools = tools
    const choice = toolChoice(body.tool_choice)
    if (choice !== undefined) openai.tool_choice = choice
    if (body.tool_choice && body.tool_choice.disable_parallel_tool_use) openai.parallel_tool_calls = false
  }

  // Claude Code's effort (/effort, CLAUDE_CODE_EFFORT_LEVEL) comes in
  // output_config.effort; buildInput maps it to the nearest level each model
  // takes. thinking off asks for the lowest effort the model takes (none where
  // it can), whatever the effort says.
  const think = body.thinking && body.thinking.type
  const effort = body.output_config && typeof body.output_config.effort === 'string' ? body.output_config.effort : ''
  if (think === 'disabled') openai.reasoning_effort = 'none'
  else if (effort) openai.reasoning_effort = effort
  else if (think === 'enabled' || think === 'adaptive') openai.reasoning_effort = 'high'

  const fmt = body.output_config && body.output_config.format
  if (fmt && fmt.type === 'json_schema' && fmt.schema) {
    openai.response_format = { type: 'json_schema', json_schema: { name: 'output', schema: fmt.schema } }
  }

  const stream = body.stream === true
  if (stream) openai.stream = true
  return { openai, requestedModel: typeof body.model === 'string' ? body.model : '', stream }
}

// Anthropic server tools (web search, web fetch, code execution...) have a type
// and no input_schema. jell0 has none of them: a request whose only tools are
// server tools (Claude Code's WebSearch side request) gets a 400 instead of a
// model answer posing as search results. The tool types, or null.
export function serverToolsOnly(body = {}) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  if (!tools.length || !tools.every(t => t && typeof t.type === 'string' && !t.input_schema)) return null
  return tools.map(t => t.type)
}

// Claude Code's first system block is an attribution line
// (x-anthropic-billing-header: ..., with a fingerprint per conversation). It is
// for Anthropic's endpoint only; sent to a model, it would sit at the very start
// of the prompt and spoil the prompt cache across conversations.
function withoutAttribution(system) {
  if (Array.isArray(system) && system[0] && typeof system[0].text === 'string' && system[0].text.startsWith('x-anthropic-billing-header:')) {
    return system.slice(1)
  }
  return system
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n')
}

function toolChoice(tc) {
  if (!tc || typeof tc !== 'object') return undefined
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'any') return 'required'
  if (tc.type === 'none') return 'none'
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } }
  return undefined
}

function assistantMessage(content) {
  if (typeof content === 'string') return { role: 'assistant', content }
  const texts = []
  const calls = []
  for (const b of Array.isArray(content) ? content : []) {
    if (!b) continue
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'tool_use') {
      calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })
    }
    // thinking and redacted_thinking blocks are not sent back to open models
  }
  const msg = { role: 'assistant', content: texts.join('') }
  if (calls.length) msg.tool_calls = calls
  return msg
}

// One Anthropic user turn can become several OpenAI messages: a `tool` message
// per tool_result (these must follow the assistant tool_calls), then one user
// message with everything else.
function userMessages(content) {
  if (typeof content === 'string') return [{ role: 'user', content }]
  const out = []
  const parts = []
  for (const b of Array.isArray(content) ? content : []) {
    if (!b) continue
    if (b.type === 'tool_result') {
      const { text, images } = toolResultContent(b.content)
      let s = text || (images.length ? '(image output follows)' : '(no output)')
      if (b.is_error) s = 'Error: ' + s
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: s })
      parts.push(...images) // tool messages cannot carry images; the user message can
    } else {
      const p = userPart(b)
      if (p) parts.push(p)
    }
  }
  if (parts.length) {
    const allText = parts.every(p => p.type === 'text')
    out.push({ role: 'user', content: allText ? parts.map(p => p.text).join('\n\n') : parts })
  }
  if (!out.length) out.push({ role: 'user', content: '' })
  return out
}

function userPart(b) {
  if (b.type === 'text') return typeof b.text === 'string' ? { type: 'text', text: b.text } : null
  if (b.type === 'image') return imagePart(b)
  if (b.type === 'document') return documentPart(b)
  return null
}

function documentPart(b) {
  const src = b.source || {}
  if (src.type === 'text' && typeof src.data === 'string') return { type: 'text', text: src.data }
  if (src.type === 'content') return { type: 'text', text: textOf(src.content) }
  return { type: 'text', text: '[document omitted: jell0 only passes text documents]' }
}

function imagePart(b) {
  const src = b.source || {}
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } }
  }
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } }
  return { type: 'text', text: '[image omitted: unsupported image source]' }
}

function toolResultContent(c) {
  if (typeof c === 'string') return { text: c, images: [] }
  const texts = []
  const images = []
  for (const b of Array.isArray(c) ? c : []) {
    if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b && b.type === 'image') images.push(imagePart(b))
    else if (b && b.type === 'document') texts.push(documentPart(b).text)
    // Claude Code's ToolSearch answers with tool_reference blocks. jell0 sends
    // every tool anyway, so the model only needs to know the tool is there.
    else if (b && b.type === 'tool_reference' && typeof b.tool_name === 'string') texts.push('Tool loaded: ' + b.tool_name + ' (it is in your tool list).')
  }
  return { text: texts.join('\n'), images }
}

// ---------------------------------------------------------------- response

// OpenAI chat completion JSON -> Anthropic message JSON. stops = the request's
// stop_sequences; stop_sequence is reported when the model says which one it hit.
export function openAIToAnthropic(chat = {}, requestedModel = '', stops = []) {
  const choice = (chat.choices && chat.choices[0]) || {}
  const msg = choice.message || {}
  const content = []
  const thinking = msg.reasoning_content ?? msg.reasoning
  if (typeof thinking === 'string' && thinking) content.push({ type: 'thinking', thinking, signature: '' })
  const text = contentText(msg.content)
  if (text) content.push({ type: 'text', text })
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    const fn = tc.function || {}
    content.push({ type: 'tool_use', id: tc.id || newId('toolu_'), name: fn.name || '', input: parseArgs(fn.arguments) })
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  const hasTools = content.some(b => b.type === 'tool_use')
  const matched = matchedStop(choice)
  const reason = stopReason(choice.finish_reason, hasTools, matched, stops)
  return {
    id: typeof chat.id === 'string' && chat.id ? 'msg_' + chat.id.replace(/^chatcmpl-/, '') : newId('msg_'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: reason,
    stop_sequence: reason === 'stop_sequence' ? matched : null,
    usage: usageOf(chat.usage),
  }
}

function contentText(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('')
  return ''
}

// Tool arguments arrive as a JSON string. Anthropic needs an object. Bad JSON
// is kept under _raw_arguments so the client sees what the model sent instead
// of a silently empty input.
function parseArgs(a) {
  if (a && typeof a === 'object' && !Array.isArray(a)) return a
  if (typeof a !== 'string' || !a.trim()) return {}
  try {
    let v = JSON.parse(a)
    if (typeof v === 'string') v = JSON.parse(v) // some models double-encode
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch {}
  return { _raw_arguments: a }
}

// The stop string the upstream says it hit (vLLM stop_reason, SGLang matched_stop).
function matchedStop(choice) {
  const s = choice && (choice.stop_reason ?? choice.matched_stop)
  return typeof s === 'string' ? s : null
}

function stopReason(finish, hasTools, matched = null, stops = []) {
  if (finish === 'length') return 'max_tokens'
  if (finish === 'content_filter') return 'refusal'
  if (hasTools) return 'tool_use'
  if (matched !== null && Array.isArray(stops) && stops.includes(matched)) return 'stop_sequence'
  return 'end_turn'
}

// Anthropic input_tokens excludes cache reads; OpenAI prompt_tokens includes them.
function usageOf(u) {
  const cached = (u && u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  const prompt = (u && u.prompt_tokens) || 0
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: (u && u.completion_tokens) || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  }
}

function newId(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, '')
}

// ---------------------------------------------------------------- streaming

// OpenAI SSE bytes -> Anthropic SSE bytes, chunk by chunk (nothing is held
// back). Event order: message_start, then per block content_block_start /
// _delta / _stop with indexes 0, 1, 2..., then message_delta and message_stop.
// Tool calls stream as they arrive: a tool_use block opens on a call's first
// piece and each arguments piece goes out as input_json_delta. Arguments that
// do not start as a JSON object (double-encoded, or junk) are held and sent
// parsed when the block closes. Upstreams send tool calls one after another; if
// one sends a piece for a call whose block is already closed, the stream ends
// with an error event rather than a broken tool call.
// A ping event goes out every pingMs while nothing else does, so idle timeouts
// do not cut a long tool call. An upstream error becomes an Anthropic `error`
// event, then the stream closes.
export function openAISSEToAnthropicSSE(upstream, requestedModel = '', { stops = [], pingMs = PING_MS } = {}) {
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const tr = translator(requestedModel, stops)
  const PING = Symbol('ping')
  let buf = ''
  let upstreamDone = false
  let pending = null
  let timer = null

  async function read() {
    if (!pending) pending = reader.read()
    let r
    try {
      if (pingMs > 0) r = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(PING), pingMs) })])
      else r = await pending
    } finally {
      clearTimeout(timer)
      timer = null
    }
    if (r !== PING) pending = null
    return r
  }

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(tr.drain()))
    },
    async pull(controller) {
      // Loop until something is sent: a pull that enqueues nothing is not
      // called again, which would stall the reader.
      for (;;) {
        let stop = false
        try {
          const r = await read()
          if (r === PING) {
            controller.enqueue(encoder.encode(PING_EVENT))
            return
          }
          const { value, done } = r
          if (done) {
            upstreamDone = true
            buf += decoder.decode()
            buf += '\n'
          } else {
            buf += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
          }
          const lines = buf.split(/\r?\n/)
          buf = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') { tr.end(); stop = true; break }
            let chunk
            try { chunk = JSON.parse(data) } catch { continue }
            if (chunk && chunk.error) { tr.fail(chunk.error); stop = true; break }
            tr.chunk(chunk)
          }
          if (!stop && upstreamDone) { tr.end(); stop = true }
        } catch (err) {
          tr.fail(err)
          stop = true
        }
        const out = tr.drain()
        if (out) controller.enqueue(encoder.encode(out))
        if (stop) {
          controller.close()
          if (!upstreamDone) reader.cancel().catch(() => {})
          return
        }
        if (out) return
      }
    },
    cancel(reason) {
      clearTimeout(timer)
      return reader.cancel(reason)
    },
  })
}

function translator(requestedModel, stops = []) {
  const out = []
  let index = -1
  let open = null // 'text' | 'thinking' | 'tool_use' | null
  const calls = new Map() // tool call key -> { id, name, args, sent, mode, opened, done }
  const idKeys = new Map()
  let current = null // the tool call whose block is open
  let lastKey = null
  let fresh = 0
  let interleaved = false
  let finish = null
  let matched = null
  let usage = null

  const ev = (type, data = {}) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const jsonDelta = partial => ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: partial } })

  // Send what is left of a tool call's arguments before its block closes.
  const finishTool = call => {
    if (call.mode === null) call.mode = call.args.trimStart().startsWith('{') ? 'live' : 'held'
    if (call.mode === 'live') {
      if (call.args.length > call.sent) jsonDelta(call.args.slice(call.sent))
    } else {
      const input = parseArgs(call.args)
      if (Object.keys(input).length) jsonDelta(JSON.stringify(input))
    }
    call.sent = call.args.length
    call.done = true
  }
  const closeBlock = () => {
    if (!open) return
    if (open === 'tool_use' && current) { finishTool(current); current = null }
    ev('content_block_stop', { index })
    open = null
  }
  const openBlock = (kind, block) => {
    closeBlock()
    index++
    open = kind
    ev('content_block_start', { index, content_block: block })
  }
  const openTool = call => {
    if (!call.id) call.id = newId('toolu_')
    openBlock('tool_use', { type: 'tool_use', id: call.id, name: call.name, input: {} })
    call.opened = true
    current = call
  }
  // Stream a live call's new arguments. The mode is set by the first
  // non-blank character: '{' streams live, anything else is held.
  const flush = call => {
    if (call.mode === null) {
      const t = call.args.trimStart()
      if (!t) return
      call.mode = t[0] === '{' ? 'live' : 'held'
    }
    if (call.mode === 'live' && call.args.length > call.sent) {
      jsonDelta(call.args.slice(call.sent))
      call.sent = call.args.length
    }
  }
  // Which call a piece belongs to. Without an index, a new id (or a name and no
  // id) starts a new call; a piece with neither continues the last one.
  const keyOf = tc => {
    if (Number.isInteger(tc.index)) return 'i:' + tc.index
    if (tc.id && idKeys.has(tc.id)) return idKeys.get(tc.id)
    const fn = tc.function || {}
    if (tc.id || fn.name || lastKey === null) {
      const k = 'n:' + fresh++
      if (tc.id) idKeys.set(tc.id, k)
      return k
    }
    return lastKey
  }

  ev('message_start', {
    message: {
      id: newId('msg_'), type: 'message', role: 'assistant', model: requestedModel, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  return {
    drain() {
      return out.splice(0).join('')
    },
    chunk(c) {
      if (!c || typeof c !== 'object') return
      if (c.usage) usage = c.usage
      const choice = Array.isArray(c.choices) ? c.choices[0] : null
      if (!choice) return
      const d = choice.delta || choice.message || {}
      const r = d.reasoning_content ?? d.reasoning
      if (typeof r === 'string' && r) {
        if (open !== 'thinking') openBlock('thinking', { type: 'thinking', thinking: '', signature: '' })
        ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: r } })
      }
      if (typeof d.content === 'string' && d.content) {
        if (open !== 'text') openBlock('text', { type: 'text', text: '' })
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } })
      }
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        if (!tc) continue
        const key = keyOf(tc)
        lastKey = key
        let call = calls.get(key)
        if (!call) { call = { id: '', name: '', args: '', sent: 0, mode: null, opened: false, done: false }; calls.set(key, call) }
        if (tc.id && !call.id) call.id = tc.id
        const fn = tc.function || {}
        if (fn.name && !call.name) call.name = fn.name
        let piece = ''
        if (typeof fn.arguments === 'string') piece = fn.arguments
        else if (fn.arguments && typeof fn.arguments === 'object' && !call.args) piece = JSON.stringify(fn.arguments)
        if (call.done) { if (piece) interleaved = true; continue }
        call.args += piece
        if (call !== current) {
          if (!call.name) continue // its block opens once its name is known
          openTool(call)
        }
        flush(call)
      }
      const m = matchedStop(choice)
      if (m !== null) matched = m
      if (choice.finish_reason) finish = choice.finish_reason
    },
    end() {
      closeBlock()
      for (const call of calls.values()) if (!call.opened) { openTool(call); closeBlock() }
      if (interleaved) {
        ev('error', { error: { type: 'api_error', message: 'jell0: the model interleaved two tool calls, which jell0 cannot stream. Try again.' } })
        return
      }
      if (index < 0) { openBlock('text', { type: 'text', text: '' }); closeBlock() }
      const reason = stopReason(finish, calls.size > 0, matched, stops)
      ev('message_delta', {
        delta: { stop_reason: reason, stop_sequence: reason === 'stop_sequence' ? matched : null },
        usage: usageOf(usage),
      })
      ev('message_stop')
    },
    fail(err) {
      closeBlock()
      ev('error', { error: { type: errorType(err), message: errorMessage(err) } })
    },
  }
}

function errorMessage(e) {
  if (typeof e === 'string' && e) return e
  if (e && typeof e.message === 'string' && e.message) return e.message
  return 'Upstream model stream failed'
}

function errorType(e) {
  const code = String((e && (e.code ?? e.status)) ?? '')
  const text = code + ' ' + errorMessage(e)
  if (code === '429' || /rate.?limit/i.test(text)) return 'rate_limit_error'
  if (code === '503' || code === '529' || /overload|capacity/i.test(text)) return 'overloaded_error'
  return 'api_error'
}

// ---------------------------------------------------------------- helpers

// Rough estimate for POST /v1/messages/count_tokens: about 4 characters per
// token over system, messages and tools, plus a flat cost per image (image
// bytes are not counted as text).
export function countTokens(body = {}) {
  let images = 0
  const json = JSON.stringify({ s: body.system, m: body.messages, t: body.tools }, (key, v) => {
    if (key === 'signature' || key === 'cache_control') return undefined
    if (v && typeof v === 'object' && (v.type === 'image' || (v.type === 'document' && v.source && v.source.type === 'base64'))) {
      images++
      return undefined
    }
    return v
  }) || ''
  return { input_tokens: Math.max(1, Math.ceil(json.length / 4) + images * IMAGE_TOKENS) }
}

// Anthropic error JSON response, e.g. anthropicError(401, 'authentication_error', 'Invalid API key').
export function anthropicError(status, type, message) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
