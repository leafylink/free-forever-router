// The one Workers AI runner. Calls env.AI.run(modelId, body) down a chain of
// catalog models and answers in proper OpenAI Chat Completions JSON or SSE,
// whatever shape the model replied in. No other provider exists.
//
// Reply shapes normalized (not every model's shape is verified):
//   newer models: { choices: [{ message: { content, tool_calls, reasoning_content }, finish_reason }], usage }
//                 streaming OpenAI chunks: data: {"choices":[{"delta":{...}}]} ... data: [DONE]
//   older models: { response, tool_calls: [{ name, arguments }], usage }
//                 streaming data: {"response":"..."} ... data: [DONE]
//   Responses API (gpt-oss may answer this way): { object: "response", output: [...], output_text, usage }
//                 streaming data: {"type":"response.output_text.delta", ...}

import { MODELS_BY_ID, MAX_OUTPUT, DEFAULT_OUTPUT } from './catalog.js'

export const MAX_TOKENS_CAP = MAX_OUTPUT
export const DEFAULT_MAX_TOKENS = DEFAULT_OUTPUT

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Jell0-Routed, X-Jell0-Lane',
  'Cache-Control': 'no-store',
}

// Fields passed to Workers AI as they are. Everything else the client sends
// (provider, reasoning_details, ...) is dropped. Models marked chat in the
// catalog also get parallel_tool_calls, and stream_options { include_usage }
// when streaming, so the stream carries token usage.
const PASS = ['tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'response_format']
const MESSAGE_KEYS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id']
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const enc = new TextEncoder()
const rand = () => crypto.randomUUID().replace(/-/g, '')
const chatId = () => 'chatcmpl-' + rand().slice(0, 24)
const callId = () => 'call_' + rand().slice(0, 24)
const now = () => Math.floor(Date.now() / 1000)

// The model answered (and was billed) but jell0 cannot read the reply. Not
// retried on another model, so one bad shape never bills twice.
export class ShapeError extends Error {}

// The effort level the model takes that is closest to the one asked for (ties go up).
export function nearestEffort(asked, levels) {
  if (!asked || !Array.isArray(levels) || !levels.length) return undefined
  if (levels.includes(asked)) return asked
  const want = EFFORT_RANK.indexOf(asked)
  if (want < 0) return undefined
  let best
  let gap = Infinity
  for (const l of levels) {
    const r = EFFORT_RANK.indexOf(l)
    if (r < 0) continue
    const d = Math.abs(r - want)
    if (d < gap || (d === gap && r > want)) { best = l; gap = d }
  }
  return best
}

function effortOf(body) {
  if (typeof body.reasoning_effort === 'string') return body.reasoning_effort
  if (body.reasoning && typeof body.reasoning.effort === 'string') return body.reasoning.effort
  const t = body.thinking && body.thinking.type
  if (t === 'enabled' || t === 'adaptive') return 'high' // Anthropic thinking
  if (t === 'disabled') return 'none' // the lowest level the model takes
  return null
}

function cleanMessages(messages) {
  return oneSystemMessage((Array.isArray(messages) ? messages : []).map(m => {
    if (!m || typeof m !== 'object') return m
    const o = {}
    for (const k of MESSAGE_KEYS) if (m[k] !== undefined) o[k] = m[k]
    if (o.content === null || o.content === undefined) o.content = ''
    if (Array.isArray(o.content)) {
      o.content = o.content.map(p => {
        if (!p || typeof p !== 'object') return p
        const { cache_control, ...rest } = p
        return rest
      })
    }
    if (Array.isArray(o.tool_calls)) o.tool_calls = o.tool_calls.map(tc => toolCall(tc))
    return o
  }))
}

const isSystem = m => !!(m && typeof m === 'object' && m.role === 'system')
const reminder = texts => texts.map(t => '<system-reminder>\n' + t + '\n</system-reminder>').join('\n\n')

function systemText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(p => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n\n')
}

// A user message with system text added as a reminder, before or after its own.
function withReminder(m, texts, before) {
  const r = reminder(texts)
  if (Array.isArray(m.content)) {
    const part = { type: 'text', text: r }
    return { ...m, content: before ? [part, ...m.content] : [...m.content, part] }
  }
  const own = typeof m.content === 'string' ? m.content : ''
  return { ...m, content: !own ? r : before ? r + '\n\n' + own : own + '\n\n' + r }
}

// At most one system message, and only first. Workers AI chat templates
// (Qwen 3.5 and later, for one) refuse a system message that is not first, and
// some refuse two in a row. OpenCode sends two at the start; Claude Code sends
// role "system" entries mid-conversation. So the leading ones join into one,
// and the text of each later one moves into the next user message (or the last
// message, when it ends the conversation) as a <system-reminder>, the shape
// Claude Code itself falls back to.
function oneSystemMessage(messages) {
  let i = 0
  const head = []
  for (; i < messages.length && isSystem(messages[i]); i++) {
    const t = systemText(messages[i].content)
    if (t) head.push(t)
  }
  const out = head.length ? [{ role: 'system', content: head.join('\n\n') }] : []
  let pending = []
  for (; i < messages.length; i++) {
    const m = messages[i]
    if (isSystem(m)) {
      const t = systemText(m.content)
      if (t) pending.push(t)
    } else if (pending.length && m && m.role === 'user') {
      out.push(withReminder(m, pending, true))
      pending = []
    } else {
      out.push(m)
    }
  }
  if (pending.length) {
    const last = out[out.length - 1]
    if (last && last.role === 'user') out[out.length - 1] = withReminder(last, pending, false)
    else out.push({ role: 'user', content: reminder(pending) })
  }
  return out
}

// Chat body -> the input Workers AI gets for this model.
export function buildInput(model, body = {}, stream = false) {
  const input = { messages: cleanMessages(body.messages) }
  for (const k of PASS) if (body[k] !== undefined && body[k] !== null) input[k] = body[k]
  if (Array.isArray(input.tools) && !input.tools.length) { delete input.tools; delete input.tool_choice }
  const cap = Math.min(model.maxOutput || MAX_TOKENS_CAP, MAX_TOKENS_CAP)
  const asked = Number(body.max_completion_tokens ?? body.max_tokens)
  const n = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), cap) : Math.min(DEFAULT_MAX_TOKENS, cap)
  if (body.max_completion_tokens != null) input.max_completion_tokens = n
  else input.max_tokens = n
  if (stream) input.stream = true
  if (model.chat) {
    if (input.tools && typeof body.parallel_tool_calls === 'boolean') input.parallel_tool_calls = body.parallel_tool_calls
    if (stream) input.stream_options = { include_usage: true }
  }
  const effort = effortOf(body)
  if (effort && model.reasoning) {
    if (model.thinkingToggle) input.chat_template_kwargs = { enable_thinking: effort !== 'none' }
    else {
      const e = nearestEffort(effort, model.efforts)
      if (e) input.reasoning_effort = e
    }
  }
  return input
}

function toolCall(tc, index) {
  const fn = (tc && (tc.function || tc)) || {}
  const args = fn.arguments
  const out = {
    id: (tc && (tc.id || tc.call_id)) || callId(),
    type: 'function',
    function: { name: fn.name || '', arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
  }
  if (index !== undefined) out.index = index
  return out
}

function normUsage(u) {
  u = u && typeof u === 'object' ? u : {}
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0
  const completion = u.completion_tokens ?? u.output_tokens ?? 0
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: u.total_tokens ?? prompt + completion }
  if (u.prompt_tokens_details) out.prompt_tokens_details = u.prompt_tokens_details
  else if (u.input_tokens_details) out.prompt_tokens_details = u.input_tokens_details
  if (u.completion_tokens_details) out.completion_tokens_details = u.completion_tokens_details
  return out
}

function errorText(x) {
  if (!x) return 'upstream error'
  if (typeof x === 'string') return x
  if (typeof x.message === 'string' && x.message) return x.message
  if (x.error) return errorText(x.error)
  if (Array.isArray(x.errors) && x.errors.length) return errorText(x.errors[0])
  return 'upstream error'
}

function isErrorAnswer(x) {
  return !!(x && typeof x === 'object' && (x.error || (Array.isArray(x.errors) && x.errors.length) || x.success === false || x.type === 'error'))
}

// Why a model call failed, from the Workers AI error (codes from the Workers AI
// errors page). 'invalid' stops the chain (the request itself is bad, another
// model would refuse it too: 3006 request too large, 5004 invalid data, 3003
// incomplete request, 8001 invalid input); every other kind falls back to the
// next model.
export function errorKind(e) {
  const code = e && typeof e === 'object' ? String(e.code ?? e.status ?? '') : ''
  const text = code + ' ' + errorText(e)
  if (/\b(429|3040|3036)\b|rate.?limit|capacity|too many requests|overloaded/i.test(text)) return 'rate'
  if (/context (length|window|size)|maximum context|too many (input |prompt )?tokens|(prompt|input) is too long|token limit/i.test(text)) return 'context'
  if (/\b(8001|5004|3003|3006)\b|invalid input|invalid data|request is too large/i.test(text)) return 'invalid'
  return 'other'
}

// Responses API reply -> a Chat Completions shaped object.
function fromResponses(out) {
  const texts = []
  const thinking = []
  const calls = []
  for (const item of Array.isArray(out.output) ? out.output : []) {
    if (!item || typeof item !== 'object') continue
    const parts = Array.isArray(item.content) ? item.content : []
    if (item.type === 'message') {
      for (const p of parts) if (p && typeof p.text === 'string' && (p.type === 'output_text' || p.type === 'text')) texts.push(p.text)
    } else if (item.type === 'function_call') {
      calls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name || '', arguments: item.arguments ?? '' } })
    } else if (item.type === 'reasoning') {
      const src = parts.length ? parts : Array.isArray(item.summary) ? item.summary : []
      for (const p of src) if (p && typeof p.text === 'string') thinking.push(p.text)
    }
  }
  const content = texts.length ? texts.join('') : typeof out.output_text === 'string' ? out.output_text : ''
  const message = { role: 'assistant', content, tool_calls: calls }
  if (thinking.length) message.reasoning_content = thinking.join('')
  const cut = out.status === 'incomplete' && out.incomplete_details && out.incomplete_details.reason === 'max_output_tokens'
  return { choices: [{ index: 0, message, finish_reason: cut ? 'length' : null }], usage: out.usage, created: out.created_at }
}

function stopReasonOf(c) {
  const s = c && (c.stop_reason ?? c.matched_stop)
  return typeof s === 'string' ? s : undefined
}

// Any Workers AI reply -> OpenAI chat completion JSON. Throws on an error
// answer, and a ShapeError on a reply it cannot read. single keeps only the
// first tool call (the client asked for no parallel tool calls).
export function normalizeJSON(out, modelId, { single = false } = {}) {
  if (out === null || out === undefined) throw new Error('empty reply')
  if (typeof out === 'string') out = { response: out }
  if (isErrorAnswer(out)) throw new Error(errorText(out))
  if (out.result && typeof out.result === 'object' && !out.choices && !('response' in out)) out = out.result
  if (!Array.isArray(out.choices) && (out.object === 'response' || Array.isArray(out.output))) out = { ...fromResponses(out), id: undefined }
  const base = { id: typeof out.id === 'string' && out.id ? out.id : chatId(), object: 'chat.completion', created: out.created || now(), model: modelId }
  if (Array.isArray(out.choices)) {
    const choices = out.choices.map((c, i) => {
      const src = (c && c.message) || {}
      const msg = { role: 'assistant', content: src.content ?? null }
      let calls = Array.isArray(src.tool_calls) ? src.tool_calls.map(tc => toolCall(tc)) : []
      if (single) calls = calls.slice(0, 1)
      if (calls.length) msg.tool_calls = calls
      const thinking = src.reasoning_content ?? src.reasoning
      if (typeof thinking === 'string' && thinking) msg.reasoning_content = thinking
      if (msg.content === null && !calls.length) msg.content = ''
      const choice = { index: c && c.index != null ? c.index : i, message: msg, finish_reason: finish(c && c.finish_reason, calls.length > 0) }
      const sr = stopReasonOf(c)
      if (sr !== undefined) choice.stop_reason = sr
      return choice
    })
    return { ...base, choices, usage: normUsage(out.usage) }
  }
  if ('response' in out || Array.isArray(out.tool_calls)) {
    const content = typeof out.response === 'string' ? out.response : out.response == null ? '' : JSON.stringify(out.response)
    let calls = (Array.isArray(out.tool_calls) ? out.tool_calls : []).map(tc => toolCall(tc))
    if (single) calls = calls.slice(0, 1)
    const msg = { role: 'assistant', content: calls.length && !content ? null : content }
    if (calls.length) msg.tool_calls = calls
    return { ...base, choices: [{ index: 0, message: msg, finish_reason: finish(null, calls.length > 0) }], usage: normUsage(out.usage) }
  }
  throw new ShapeError('unrecognized reply shape')
}

function finish(reason, hasTools) {
  if (hasTools && (!reason || reason === 'stop')) return 'tool_calls'
  return reason || 'stop'
}

// Stateful SSE normalizer: feed it upstream text, get OpenAI SSE text back.
export function sseNormalizer(modelId, { single = false } = {}) {
  const id = chatId()
  const created = now()
  const out = []
  const seenCalls = new Set()
  const idIndex = new Map() // upstream tool call id -> index, for upstreams that send no index
  const respIndex = new Map() // Responses API output_index -> tool call index
  let nextIndex = 0
  let lastIndex = -1
  let firstTool = null
  let buf = ''
  let started = false
  let finished = false
  let done = false
  let sawTools = false
  let usage = null
  let endReason = null
  const st = { error: null }

  const emit = obj => out.push('data: ' + JSON.stringify(obj) + '\n\n')
  const chunk = (choices, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model: modelId, choices, ...extra })
  const keep = i => {
    if (!single) return true
    if (firstTool === null) firstTool = i
    return i === firstTool
  }
  const fail = message => {
    st.error = message
    emit({ error: { message, type: 'server_error', code: 'upstream_error' } })
  }

  // The tool call index for one upstream piece. Without an index, a piece with
  // a new id (or a name and no id) starts a new call; a piece with neither
  // continues the last call.
  function indexFor(tc) {
    let i
    if (Number.isInteger(tc && tc.index)) i = tc.index
    else if (tc && tc.id && idIndex.has(tc.id)) i = idIndex.get(tc.id)
    else if ((tc && tc.id) || (tc && tc.function && tc.function.name) || lastIndex < 0) i = nextIndex
    else i = lastIndex
    if (tc && tc.id && !idIndex.has(tc.id)) idIndex.set(tc.id, i)
    nextIndex = Math.max(nextIndex, i + 1)
    lastIndex = i
    return i
  }

  function role(delta) {
    if (!started) { delta.role = 'assistant'; started = true }
    return delta
  }

  function end() {
    if (done || st.error) return
    if (!finished) {
      emit(chunk([{ index: 0, delta: {}, finish_reason: endReason || (sawTools ? 'tool_calls' : 'stop') }], usage ? { usage: normUsage(usage) } : {}))
      finished = true
      usage = null
    } else if (usage) {
      emit(chunk([], { usage: normUsage(usage) })) // usage that came after finish_reason
      usage = null
    }
    out.push('data: [DONE]\n\n')
    done = true
  }

  // Responses API stream events.
  function responsesEvent(j) {
    const t = j.type
    if (t === 'response.output_text.delta' && typeof j.delta === 'string' && j.delta) {
      emit(chunk([{ index: 0, delta: role({ content: j.delta }), finish_reason: null }]))
    } else if ((t === 'response.reasoning_text.delta' || t === 'response.reasoning_summary_text.delta') && typeof j.delta === 'string' && j.delta) {
      emit(chunk([{ index: 0, delta: role({ reasoning_content: j.delta }), finish_reason: null }]))
    } else if (t === 'response.output_item.added' && j.item && j.item.type === 'function_call') {
      const i = nextIndex++
      respIndex.set(j.output_index, i)
      sawTools = true
      if (!keep(i)) return
      const call = { index: i, id: j.item.call_id || j.item.id || callId(), type: 'function', function: { name: j.item.name || '', arguments: typeof j.item.arguments === 'string' ? j.item.arguments : '' } }
      emit(chunk([{ index: 0, delta: role({ tool_calls: [call] }), finish_reason: null }]))
    } else if (t === 'response.function_call_arguments.delta' && typeof j.delta === 'string' && respIndex.has(j.output_index)) {
      const i = respIndex.get(j.output_index)
      if (!keep(i)) return
      emit(chunk([{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: j.delta } }] }, finish_reason: null }]))
    } else if (t === 'response.completed' || t === 'response.incomplete') {
      const r = j.response || {}
      if (r.usage) usage = r.usage
      if (r.status === 'incomplete' && r.incomplete_details && r.incomplete_details.reason === 'max_output_tokens') endReason = 'length'
    } else if (t === 'response.failed') {
      fail(errorText((j.response && j.response.error) || 'response failed'))
    }
  }

  function handle(data) {
    if (done || st.error) return
    if (data === '[DONE]') return end()
    let j
    try { j = JSON.parse(data) } catch { return }
    if (!j || typeof j !== 'object') return
    if (isErrorAnswer(j)) return fail(errorText(j))
    if (Array.isArray(j.choices)) {
      const choices = []
      for (const [n, c] of j.choices.entries()) {
        const d = { ...((c && (c.delta || c.message)) || {}) }
        if (typeof d.reasoning === 'string') {
          if (d.reasoning_content == null) d.reasoning_content = d.reasoning
          delete d.reasoning
        }
        if (Array.isArray(d.tool_calls)) {
          sawTools = sawTools || d.tool_calls.length > 0
          const calls = []
          for (const tc of d.tool_calls) {
            const t = { ...tc, index: indexFor(tc) }
            if (!keep(t.index)) continue
            if (t.function && t.function.arguments && typeof t.function.arguments === 'object') {
              t.function = { ...t.function, arguments: JSON.stringify(t.function.arguments) }
            }
            if (!seenCalls.has(t.index)) {
              seenCalls.add(t.index)
              t.id = t.id || callId()
              t.type = t.type || 'function'
            }
            calls.push(t)
          }
          if (calls.length) d.tool_calls = calls
          else delete d.tool_calls
        }
        let fr = (c && c.finish_reason) || null
        if (fr) { fr = finish(fr, sawTools); finished = true }
        const choice = { index: c && c.index != null ? c.index : n, delta: d, finish_reason: fr }
        const sr = stopReasonOf(c)
        if (sr !== undefined) choice.stop_reason = sr
        choices.push(choice)
      }
      started = true
      if (j.usage) usage = null
      emit(chunk(choices, j.usage ? { usage: normUsage(j.usage) } : {}))
      return
    }
    if (typeof j.type === 'string' && j.type.startsWith('response.')) return responsesEvent(j)
    const text = typeof j.response === 'string' ? j.response : ''
    const calls = Array.isArray(j.tool_calls) ? j.tool_calls : []
    if (text || calls.length) {
      const delta = role({})
      if (text) delta.content = text
      const kept = []
      for (const tc of calls) {
        sawTools = true
        const i = nextIndex++
        if (keep(i)) kept.push(toolCall(tc, i))
      }
      if (kept.length) delta.tool_calls = kept
      emit(chunk([{ index: 0, delta, finish_reason: null }]))
    }
    if (j.usage) {
      // usage alone (no choices key): send it now if the finish chunk already went out
      if (finished) emit(chunk([], { usage: normUsage(j.usage) }))
      else usage = j.usage
    }
  }

  function lines(final) {
    const parts = buf.split('\n')
    buf = final ? '' : parts.pop()
    for (let line of parts) {
      line = line.replace(/\r$/, '')
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data) handle(data)
    }
  }

  return {
    state: st,
    push(text) { buf += text; lines(false); return out.splice(0).join('') },
    end() { buf += '\n'; lines(true); end(); return out.splice(0).join('') },
  }
}

// A JSON reply (when the model did not stream) -> OpenAI SSE text.
function jsonToSSE(chat) {
  const c = chat.choices[0] || {}
  const m = c.message || {}
  const delta = { role: 'assistant' }
  if (m.reasoning_content) delta.reasoning_content = m.reasoning_content
  if (typeof m.content === 'string' && m.content) delta.content = m.content
  if (m.tool_calls) delta.tool_calls = m.tool_calls.map((tc, i) => ({ index: i, ...tc }))
  const head = { id: chat.id, object: 'chat.completion.chunk', created: chat.created, model: chat.model }
  const last = { index: 0, delta: {}, finish_reason: c.finish_reason || 'stop' }
  if (c.stop_reason !== undefined) last.stop_reason = c.stop_reason
  return 'data: ' + JSON.stringify({ ...head, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n' +
    'data: ' + JSON.stringify({ ...head, choices: [last], usage: chat.usage }) + '\n\n' +
    'data: [DONE]\n\n'
}

function textStream(text) {
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close() } })
}

// Workers AI streaming reply -> normalized OpenAI SSE stream, passed through
// chunk by chunk. The first chunk is read before answering so an error that
// arrives first can still fall back to the next model.
async function streamReply(out, modelId, opts) {
  let src = null
  if (out && typeof out.getReader === 'function') src = out
  else if (out && out.body && typeof out.body.getReader === 'function') src = out.body
  if (!src) return textStream(jsonToSSE(normalizeJSON(out, modelId, opts)))

  const reader = src.getReader()
  const dec = new TextDecoder()
  const norm = sseNormalizer(modelId, opts)
  let first = ''
  let upstreamDone = false
  while (!first) {
    const { value, done } = await reader.read()
    if (done) { upstreamDone = true; first = norm.end(); break }
    first = norm.push(typeof value === 'string' ? value : dec.decode(value, { stream: true }))
    if (norm.state.error) break
  }
  if (norm.state.error) {
    reader.cancel().catch(() => {})
    throw new Error(norm.state.error)
  }
  return new ReadableStream({
    start(c) {
      if (first) c.enqueue(enc.encode(first))
      if (upstreamDone) c.close()
    },
    async pull(c) {
      for (;;) {
        let text
        let doneNow = false
        try {
          const { value, done } = await reader.read()
          if (done) { doneNow = true; text = norm.end() } else text = norm.push(typeof value === 'string' ? value : dec.decode(value, { stream: true }))
        } catch (e) {
          text = 'data: ' + JSON.stringify({ error: { message: 'stream from ' + modelId + ' broke: ' + errorText(e), type: 'server_error', code: 'upstream_error' } }) + '\n\n'
          doneNow = true
        }
        if (text) c.enqueue(enc.encode(text))
        if (doneNow || norm.state.error) {
          c.close()
          if (!doneNow) reader.cancel().catch(() => {})
          return
        }
        if (text) return
      }
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

function note(id, e) {
  return id + ': ' + String(errorText(e)).replace(/\s+/g, ' ').slice(0, 200)
}

function errorReply(status, message, type, code, headers) {
  return new Response(JSON.stringify({ error: { message: String(message).slice(0, 1500), type, code } }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...headers },
  })
}

// Clients (the Anthropic and OpenAI SDKs, Claude Code) retry any 5xx unless the
// reply says not to, and each retry would run, and bill, a model again.
const NO_RETRY = { 'x-should-retry': 'false' }

// Try each model in the chain until one answers. Every model is Cloudflare-hosted.
// Falls back on capacity, rate limit, 5xx, model gone and context errors.
// Every model but the last is asked to reject at once when busy (rejectIfBusy,
// third argument only) instead of waiting in Workers AI's capacity queue.
// When every model said the prompt is too long, the overflow models with a
// bigger context window are tried, then the answer is 400 "prompt is too long".
// Stops at once on an invalid request (400) or a reply it cannot read (502).
export async function runChain(env, chatBody, { stream = false, chain = [], lane = '', overflow = [] } = {}) {
  const errors = []
  const kinds = []
  const opts = { single: chatBody.parallel_tool_calls === false }
  const list = chain.map(id => MODELS_BY_ID[id]).filter(Boolean)
  let biggest = 0 // the largest context window that was still too small
  let extended = false
  for (let i = 0; i < list.length; i++) {
    const model = list[i]
    const headers = { ...CORS, 'X-Jell0-Routed': 'workersai/' + model.id + (i > 0 ? ' (fallback)' : ''), 'X-Jell0-Lane': lane }
    try {
      const input = buildInput(model, chatBody, stream)
      const out = i < list.length - 1 ? await env.AI.run(model.id, input, { rejectIfBusy: true }) : await env.AI.run(model.id, input)
      if (stream) {
        const body = await streamReply(out, model.id, opts)
        return new Response(body, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8' } })
      }
      const json = normalizeJSON(out, model.id, opts)
      return new Response(JSON.stringify(json), { headers: { ...headers, 'Content-Type': 'application/json' } })
    } catch (e) {
      if (e instanceof ShapeError) {
        return errorReply(502, 'jell0: ' + model.id + ' answered in a shape jell0 cannot read. jell0 does not retry it on another model.',
          'server_error', 'unreadable_reply', { ...headers, ...NO_RETRY })
      }
      const kind = errorKind(e)
      if (kind === 'invalid') {
        return errorReply(400, 'Workers AI refused the request as invalid: ' + note(model.id, e), 'invalid_request_error', 'invalid_request', { ...headers, ...NO_RETRY })
      }
      kinds.push(kind)
      errors.push(note(model.id, e))
      if (kind === 'context') biggest = Math.max(biggest, model.context)
    }
    if (i === list.length - 1 && !extended && kinds.length && kinds.every(k => k === 'context')) {
      extended = true
      for (const id of overflow) {
        const m = MODELS_BY_ID[id]
        if (m && m.context > biggest && !list.includes(m)) list.push(m)
      }
    }
  }
  const tried = errors.join(' | ') || 'nothing'
  const none = { 'X-Jell0-Routed': 'none', 'X-Jell0-Lane': lane }
  if (kinds.length && kinds.every(k => k === 'context')) {
    return errorReply(400, 'prompt is too long: every Cloudflare model that could take this request said it is bigger than its context window. Tried: ' + tried,
      'invalid_request_error', 'context_length_exceeded', none)
  }
  if (kinds.length && kinds.every(k => k === 'rate')) {
    return errorReply(429, 'jell0: every Cloudflare model in the lane is rate limited or busy (lane ' + (lane || 'none') + '). Tried: ' + tried,
      'rate_limit_exceeded', 'rate_limit_exceeded', none)
  }
  return errorReply(503, 'jell0: no Cloudflare model could answer (lane ' + (lane || 'none') + '). Tried: ' + tried, 'server_error', 'all_models_failed', none)
}
