// jell0 model catalog and lanes. Every model here is an open model hosted by
// Cloudflare on Workers AI, called through the AI binding. Nothing else.
//
// One table, easy to edit when Cloudflare changes the catalog. Facts from the
// Cloudflare docs on 2026-11-07. Prices are USD per million tokens
// (cached = cached input; null = not listed). paid = needs the Workers Paid plan
// (prepaid AI Gateway credits would also do, but only through a gateway, and
// jell0 calls Workers AI without one). rpm = per-account requests per minute:
// 20 per model for paid models, 300 for the rest (Workers AI limits page).
// efforts = values Workers AI takes for reasoning_effort ([] = the model
// reasons but jell0 sends no effort knob). retires = the moment
// Workers AI stops serving it; successor = the model that takes its requests.
// chat = Cloudflare documents an OpenAI Chat Completions input schema for it
// (it takes stream_options and parallel_tool_calls).

export const MAX_OUTPUT = 32768 // cost ceiling for max_tokens on every model
export const DEFAULT_OUTPUT = 16384 // max_tokens when the client sends none
// Cost ceiling for the prompt (jell0's estimate), on every lane but jell0-long,
// which only its models' context windows limit. Bigger prompts get 400 before
// any model call.
export const MAX_PROMPT_TOKENS = 200000

export const MODELS = [
  {
    id: '@cf/zai-org/glm-5.3', aliases: ['glm-5.3', 'glm'], lane: 'flagship',
    chat: true,
    context: 1048576, maxOutput: MAX_OUTPUT, tools: true, vision: false,
    reasoning: true, efforts: ['low', 'high', 'max'], defaultEffort: 'max',
    retires: null, paid: true, rpm: 20, price: { in: 1.40, cached: 0.26, out: 4.40 },
    note: 'Flagship. Z.ai calls it the most capable open-weights coding model.',
  },
  {
    id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', aliases: ['deepseek-v4.1-flash', 'deepseek'], lane: 'reasoning',
    chat: true,
    context: 1048576, maxOutput: MAX_OUTPUT, tools: true, vision: true,
    reasoning: true, efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high',
    retires: null, paid: true, rpm: 20, price: { in: 0.30, cached: 0.006, out: 1.20 },
    note: 'Cloudflare\'s other recommended frontier model. Vision.',
  },
  {
    id: '@cf/qwen/qwen3.8-27b', aliases: ['qwen3.8-27b', 'qwen'], lane: 'general',
    chat: true,
    context: 262144, maxOutput: MAX_OUTPUT, tools: true, vision: true,
    reasoning: true, efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh',
    retires: null, paid: false, rpm: 300, price: { in: 0.45, cached: 0.05, out: 3.20 },
    note: 'Answers in Chat Completions shape.',
  },
  {
    id: '@cf/google/gemma-4-26b-a4b-it', aliases: ['gemma-4-26b', 'gemma'], lane: 'fast',
    chat: true,
    context: 256000, maxOutput: MAX_OUTPUT, tools: true, vision: true,
    reasoning: true, efforts: [], thinkingToggle: true, defaultEffort: null,
    retires: null, paid: false, rpm: 300, price: { in: 0.10, cached: null, out: 0.30 },
    note: 'Free plan. Thinking is switched with chat_template_kwargs.enable_thinking.',
  },
  {
    id: '@cf/openai/gpt-oss-120b', aliases: ['gpt-oss-120b'], lane: 'reasoning',
    context: 128000, maxOutput: MAX_OUTPUT, tools: true, vision: false,
    reasoning: true, efforts: ['low', 'medium', 'high'], defaultEffort: null,
    retires: null, paid: false, rpm: 300, price: { in: 0.35, cached: null, out: 0.75 },
  },
  {
    id: '@cf/openai/gpt-oss-20b', aliases: ['gpt-oss-20b'], lane: 'fast',
    context: 128000, maxOutput: MAX_OUTPUT, tools: true, vision: false,
    reasoning: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
    retires: null, paid: false, rpm: 300, price: { in: 0.20, cached: null, out: 0.30 },
  },
  {
    id: '@cf/zai-org/glm-4.7-flash', aliases: ['glm-4.7-flash'], lane: 'fast',
    chat: true,
    context: 131072, maxOutput: MAX_OUTPUT, tools: true, vision: false,
    reasoning: true, efforts: [], defaultEffort: null,
    retires: null, paid: false, rpm: 300, price: { in: 0.0605, cached: null, out: 0.40 },
    note: 'Free plan.',
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct', aliases: ['llama-4-scout'], lane: 'vision',
    context: 131000, maxOutput: MAX_OUTPUT, tools: true, vision: true,
    reasoning: false, efforts: [], defaultEffort: null,
    retires: null, paid: false, rpm: 300, price: { in: 0.27, cached: null, out: 0.85 },
  },
  {
    id: '@cf/zai-org/glm-5.2', aliases: ['glm-5.2'], lane: 'flagship',
    chat: true,
    context: 262144, maxOutput: MAX_OUTPUT, tools: true, vision: false,
    reasoning: true, efforts: ['none', 'high', 'max'], defaultEffort: null,
    retires: '2026-11-20T00:00:00Z', successor: '@cf/zai-org/glm-5.3', auto: false,
    paid: true, rpm: 20, price: { in: 1.40, cached: 0.26, out: 4.40 },
    note: 'Only by name, until Workers AI retires it. Then glm-5.3 serves its requests.',
  },
]

export const MODELS_BY_ID = Object.fromEntries(MODELS.map(m => [m.id, m]))

const GLM53 = '@cf/zai-org/glm-5.3'
const DSV41 = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
const QWEN = '@cf/qwen/qwen3.8-27b'
const GEMMA = '@cf/google/gemma-4-26b-a4b-it'
const OSS120 = '@cf/openai/gpt-oss-120b'
const OSS20 = '@cf/openai/gpt-oss-20b'
const GLM47F = '@cf/zai-org/glm-4.7-flash'
const SCOUT = '@cf/meta/llama-4-scout-17b-16e-instruct'

const TOP = [GLM53, DSV41, QWEN]
const GENERAL = [QWEN, DSV41, GEMMA]
const FAST = [GEMMA, GLM47F, OSS20]

// Each lane is an ordered fallback chain. "smart" (model jell0) is not here:
// it picks one of these lanes with the keyword classifier below. glm-5.3 is the
// priciest model, so only lanes named for it (and long, as its last resort for
// a prompt Qwen cannot hold) use it.
export const LANES = {
  flagship: TOP, max: TOP, glm: TOP, coding: TOP,
  reasoning: [DSV41, OSS120, QWEN],
  long: [DSV41, QWEN, GLM53],
  vision: [DSV41, QWEN, GEMMA, SCOUT],
  general: GENERAL, balanced: GENERAL, classic: GENERAL, creative: GENERAL,
  fast: FAST, simple: FAST, budget: FAST, free: FAST, flatline: FAST,
}

export const LANE_NAMES = ['smart', ...Object.keys(LANES)]

// The smart lane (model jell0, and any unknown name) never runs glm-5.3: a
// keyword guess is not a reason to pay the most. Its categories use these
// chains, or the lane of the same name when it has none here.
const SMART_CHAINS = {
  coding: [DSV41, QWEN, GEMMA],
  long: [DSV41, QWEN],
}

// Cheapest big-context models, tried when nothing in the asked lane fits the
// prompt. Never glm-5.3: a cheap lane must not quietly run on the priciest model.
export const OVERFLOW = [DSV41, QWEN]

// Model names: alias, full id, and the id without "@cf/". Null prototype, so
// names like "constructor" are not found by accident.
const BY_NAME = Object.create(null)
for (const m of MODELS) {
  for (const n of [...m.aliases, m.id, m.id.replace(/^@cf\//, '')]) BY_NAME[n.toLowerCase()] = m
}

export function isLane(name) {
  return typeof name === 'string' && Object.hasOwn(LANES, name)
}

export function retired(model, nowMs = Date.now()) {
  return !!(model && model.retires && nowMs >= Date.parse(model.retires))
}

const SMART = { lane: 'smart', first: null }

// Model name (or lane name) -> { lane, first, known }. first is a catalog id
// asked for by name, else null. known is false when the name meant nothing and
// the request falls to the smart lane, as before.
export function resolveTarget(name, nowMs = Date.now(), { anthropic = false } = {}) {
  let n = String(name || '').trim().toLowerCase()
  if (!n) return { ...SMART, known: false }
  if (anthropic && n.startsWith('claude')) {
    return { lane: n.includes('haiku') ? 'fast' : 'flagship', first: null, known: true }
  }
  const pre = /^jell0[-_/]?(.*)$/.exec(n)
  if (pre) n = pre[1]
  if (!n || n === 'smart' || n === 'auto') return { ...SMART, known: true }
  if (isLane(n)) return { lane: n, first: null, known: true }
  const m = BY_NAME[n]
  if (m) {
    let first = m.id
    if (retired(m, nowMs)) first = m.successor || null
    return { lane: m.lane, first, known: true }
  }
  return { ...SMART, known: false }
}

// Can this model take this request? The prompt plus the output budget must fit
// the context window.
export function fits(model, needs = {}, nowMs = Date.now()) {
  if (!model || retired(model, nowMs)) return false
  if (needs.tools && !model.tools) return false
  if (needs.vision && !model.vision) return false
  const tokens = (needs.tokens > 0 ? needs.tokens : 0) + (needs.output > 0 ? needs.output : 0)
  if (tokens > 0 && model.context < tokens) return false
  return true
}

// { lane, first } + needs -> ordered catalog ids to try. Models that lack a
// needed capability, are too small for the prompt, or are retired are skipped.
// If nothing in the lane fits, OVERFLOW is tried (never glm-5.3).
// target.smart: the smart classifier picked the lane (SMART_CHAINS).
export function chainFor(target, needs = {}, nowMs = Date.now()) {
  const lane = isLane(target && target.lane) ? target.lane : (needs.vision ? 'vision' : 'general')
  const ok = id => fits(MODELS_BY_ID[id], needs, nowMs)
  const base = (target && target.smart && SMART_CHAINS[lane]) || LANES[lane]
  let ids = [...new Set([target && target.first, ...base].filter(Boolean))].filter(ok)
  if (!ids.length) ids = OVERFLOW.filter(ok)
  return ids
}

export function modelList(nowMs = Date.now()) {
  const data = LANE_NAMES.map(l => ({
    id: l === 'smart' ? 'jell0' : 'jell0-' + l, object: 'model', created: 0, owned_by: 'jell0',
  }))
  const seen = new Set(data.map(d => d.id))
  for (const m of MODELS) {
    if (retired(m, nowMs)) continue
    for (const id of [...m.aliases, m.id]) {
      if (seen.has(id)) continue
      seen.add(id)
      data.push({ id, object: 'model', created: 0, owned_by: 'cloudflare-workers-ai', context_length: m.context })
    }
  }
  return data
}

const IMAGE_TYPES = new Set(['image_url', 'image', 'input_image'])
const IMAGE_TOKENS = 1600 // rough cost of one image; image bytes are not text

// Rough prompt size: about 4 characters per token over messages and tools.
export function estimateTokens(chatBody = {}) {
  let images = 0
  const json = JSON.stringify({ m: chatBody.messages, t: chatBody.tools }, (k, v) => {
    if (v && typeof v === 'object' && IMAGE_TYPES.has(v.type)) { images++; return undefined }
    return v
  }) || ''
  return Math.ceil(json.length / 4) + images * IMAGE_TOKENS
}

export function hasImages(messages) {
  return (Array.isArray(messages) ? messages : []).some(m =>
    m && Array.isArray(m.content) && m.content.some(p => p && IMAGE_TYPES.has(p.type)))
}

// The output budget a request reserves: what it asks for, capped at
// MAX_OUTPUT, or the default when it asks for nothing.
export function outputBudget(chatBody = {}) {
  const asked = Number(chatBody.max_completion_tokens ?? chatBody.max_tokens)
  return Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_OUTPUT) : DEFAULT_OUTPUT
}

export function needsOf(chatBody = {}) {
  return {
    tools: Array.isArray(chatBody.tools) && chatBody.tools.length > 0,
    vision: hasImages(chatBody.messages),
    tokens: estimateTokens(chatBody),
    output: outputBudget(chatBody),
  }
}

// The keyword classifier from the old jell0 (same words). Its categories are
// lane names. A category scores one point per keyword match (the g flag), long
// three; the highest score wins and ties go to the first category listed.
const KEYWORDS = {
  simple: /\b(what is|who is|define|meaning of|how to|quick|simple|yes|no|hello|hi|thanks|thank you|ok|okay)\b/gi,
  coding: /\b(code|function|bug|regex|compile|python|javascript|typescript|rust|golang|\bgo\b|java|kotlin|sql|docker|kubernetes|refactor|implement|debug|api|class|method|library|repo|git|deploy|test|css|html|bash|shell|script|algorithm)\b/gi,
  reasoning: /\b(why|prove|theorem|logic|puzzle|deduce|analyze|calculate|step[- ]?by[- ]?step|solve|reasoning|research|hypothesis|derive|probability|math)\b/gi,
  vision: /\b(image|picture|photo|screenshot|diagram|chart|ocr|visual|see|look|drawing|pixel)\b/gi,
  creative: /\b(write|story|poem|song|blog|marketing|script|brainstorm|imagine|creative|describe|novel|essay|tweet|caption)\b/gi,
  long: /\b(summariz\w* this long|large document|entire file|whole book|many pages|long context|paste the whole|thousands of lines)\b/gi,
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(p => (p && typeof p.text === 'string' ? p.text : '')).join(' ')
}

export function classify(messages) {
  const text = (Array.isArray(messages) ? messages : []).map(m => textOf(m && m.content)).join(' ').slice(0, 4000)
  let best = 'general'
  let bestScore = 0
  for (const [cat, re] of Object.entries(KEYWORDS)) {
    const matches = (text.match(re) || []).length
    const score = matches * (cat === 'long' ? 3 : 1)
    if (score > bestScore) { bestScore = score; best = cat }
  }
  return best
}

// The whole routing decision for one chat request (no model call).
// preference = the X-Jell0-Preference header, honored when it names a lane or model.
// cap = the biggest prompt this request may send (null on jell0-long, named on
// purpose). overflow = OVERFLOW models not in the chain that have what the
// request needs; runChain tries them when every model says the prompt is too long.
export function planRoute(chatBody = {}, { preference = null, anthropic = false } = {}, nowMs = Date.now()) {
  const fromHeader = preference ? resolveTarget(preference, nowMs) : null
  let target = fromHeader && fromHeader.known ? fromHeader : resolveTarget(chatBody.model, nowMs, { anthropic })
  const needs = needsOf(chatBody)
  let category = null
  if (target.lane === 'smart') {
    category = classify(chatBody.messages)
    target = { ...target, lane: needs.vision ? 'vision' : category, smart: true }
  }
  const chain = chainFor(target, needs, nowMs)
  const caps = { ...needs, tokens: 0, output: 0 }
  const overflow = OVERFLOW.filter(id => !chain.includes(id) && fits(MODELS_BY_ID[id], caps, nowMs))
  const cap = target.lane === 'long' && !target.smart ? null : MAX_PROMPT_TOKENS
  return { lane: target.lane, first: target.first, category, needs, chain, overflow, cap }
}

// The biggest context window of any model that has what the request needs.
export function biggestContext(needs = {}, nowMs = Date.now()) {
  const caps = { ...needs, tokens: 0, output: 0 }
  return Math.max(0, ...MODELS.filter(m => fits(m, caps, nowMs)).map(m => m.context))
}
