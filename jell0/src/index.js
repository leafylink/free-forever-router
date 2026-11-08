// jell0-router: a Cloudflare-only LLM router. Every model call runs on an open
// model hosted by Cloudflare on Workers AI, through the AI binding. No outside
// provider, no local model, no provider key.
//
// Routes:
//   GET  /                         short JSON description
//   GET  /health                   "ok"
//   GET  /models, /v1/models       OpenAI model list (lanes and catalog models)
//   GET  /select?prompt=&pref=     shows the chain a request would take (no model call)
//   POST /v1/chat/completions, /chat/completions   OpenAI (OpenCode); like the old
//        jell0, any path ending in /chat/completions (and GET .../models) works
//   POST /v1/messages, /messages                   Anthropic Messages (Claude Code)
//   POST /v1/messages/count_tokens                 Anthropic token estimate
//   GET/POST/DELETE /api/jell0/keys, GET /api/jell0/session   admin (JELL0_ADMIN_TOKEN)
// Everything else is 404.
//
// Deploy only through the jell0-deploy GitHub workflow, on the owner's word.

import { anthropicToOpenAI, openAIToAnthropic, openAISSEToAnthropicSSE, countTokens, anthropicError, serverToolsOnly } from './anthropic.js'
import { planRoute, modelList, biggestContext } from './catalog.js'
import { runChain } from './workersai.js'
import { keyPage } from './keypage.js'
import { adminOk, adminOff, keyKind, keyFromRequest, addKvKey, listKvKeys, loadOldKeys, deleteKvKey, overLimit, sha256hex } from './keys.js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Jell0-Routed, X-Jell0-Lane',
  'Cache-Control': 'no-store',
}

const ABOUT = {
  name: 'jell0-router',
  what: 'Cloudflare-only LLM router. Every call runs on an open model hosted on Cloudflare Workers AI.',
  openai: 'POST /v1/chat/completions',
  anthropic: 'POST /v1/messages',
  models: 'GET /v1/models',
  select: 'GET /select?prompt=...&pref=...',
  health: 'GET /health',
  auth: 'Authorization: Bearer <key> or x-api-key: <key>',
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } })
}

function openaiError(status, message, type = 'invalid_request_error', code = null) {
  return json({ error: { message, type, code } }, status)
}

function withHeaders(res, extra) {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries({ ...CORS, ...extra })) if (v != null) headers.set(k, v)
  return new Response(res.body, { status: res.status, headers })
}

async function readJson(request) {
  try {
    const b = await request.json()
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null
  } catch {
    return null
  }
}

// Both start "prompt is too long: N tokens > M maximum", the wording Claude
// Code (and OpenCode) read as a context overflow, so they compact and retry.
function tooLongMessage(plan) {
  return 'prompt is too long: ' + plan.needs.tokens + ' tokens > ' + plan.cap + ' maximum (jell0 estimate; ' + plan.cap +
    ' is jell0\'s cost cap on every lane but jell0-long).'
}

function noModelMessage(plan) {
  const n = plan.needs.tokens + plan.needs.output
  const want = [plan.needs.tools && 'tools', plan.needs.vision && 'images'].filter(Boolean)
  return 'prompt is too long: ' + n + ' tokens > ' + biggestContext(plan.needs) + ' maximum (jell0 estimate of the prompt plus the ' +
    plan.needs.output + ' token output budget; no Cloudflare model in the ' + plan.lane + ' lane' + (want.length ? ' with ' + want.join(' and ') : '') + ' can take it).'
}

const UNAUTHORIZED = 'Missing or invalid API key for jell0.'
const LIMITED = 'jell0: too many requests. Try again in a minute.'
const RETRY_AFTER = { 'Retry-After': '20' }

// Model routes: the caller's IP limit first (before any KV or D1 lookup), then
// the key, then that key's own limit (keyed by its SHA-256). null = go on.
async function admit(request, env, { keyLimit = true } = {}) {
  if (await overLimit(env.JELL0_IP_LIMIT, 'ip:' + (request.headers.get('CF-Connecting-IP') || ''))) return 'limited'
  if (!await keyKind(env, request)) return 'unauthorized'
  if (keyLimit && await overLimit(env.JELL0_KEY_LIMIT, 'key:' + await sha256hex(keyFromRequest(request)))) return 'limited'
  return null
}

function openaiRefusal(why) {
  if (why === 'limited') return json({ error: { message: LIMITED, type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } }, 429, RETRY_AFTER)
  return openaiError(401, UNAUTHORIZED, 'invalid_request_error', 'invalid_api_key')
}

function anthropicRefusal(why) {
  if (why === 'limited') return withHeaders(anthropicError(429, 'rate_limit_error', LIMITED), RETRY_AFTER)
  return anthropicError(401, 'authentication_error', UNAUTHORIZED)
}

// Anthropic error type for a jell0 error status.
function anthropicType(status) {
  if (status === 400) return 'invalid_request_error'
  if (status === 429) return 'rate_limit_error'
  return 'api_error'
}

// ---------------------------------------------------------------- OpenAI

async function chat(request, env) {
  const refused = await admit(request, env)
  if (refused) return openaiRefusal(refused)
  const body = await readJson(request)
  if (!body) return openaiError(400, 'Request body must be a JSON object.')
  if (!Array.isArray(body.messages) || !body.messages.length) return openaiError(400, 'messages must be a non-empty array.')
  const plan = planRoute(body, { preference: request.headers.get('X-Jell0-Preference') }, Date.now())
  if (plan.cap && plan.needs.tokens > plan.cap) return openaiError(400, tooLongMessage(plan), 'invalid_request_error', 'prompt_too_large')
  if (!plan.chain.length) return openaiError(400, noModelMessage(plan), 'invalid_request_error', 'no_model_fits')
  return runChain(env, body, { stream: body.stream === true, chain: plan.chain, lane: plan.lane, overflow: plan.overflow })
}

// ---------------------------------------------------------------- Anthropic

async function messages(request, env) {
  const refused = await admit(request, env)
  if (refused) return anthropicRefusal(refused)
  const body = await readJson(request)
  if (!body) return anthropicError(400, 'invalid_request_error', 'Request body must be a JSON object.')
  const server = serverToolsOnly(body)
  if (server) {
    return anthropicError(400, 'invalid_request_error', 'jell0 has no web search or other server tools (' + server.join(', ').slice(0, 200) +
      '). In Claude Code, deny WebSearch or add a search MCP server.')
  }
  let t
  try {
    t = anthropicToOpenAI(body)
  } catch {
    return anthropicError(400, 'invalid_request_error', 'Could not read this Messages request.')
  }
  if (!t.openai.messages.length) return anthropicError(400, 'invalid_request_error', 'messages must be a non-empty array.')
  const plan = planRoute({ ...t.openai, model: t.requestedModel }, { preference: request.headers.get('X-Jell0-Preference'), anthropic: true }, Date.now())
  if (plan.cap && plan.needs.tokens > plan.cap) return anthropicError(400, 'invalid_request_error', tooLongMessage(plan))
  if (!plan.chain.length) return anthropicError(400, 'invalid_request_error', noModelMessage(plan))
  const res = await runChain(env, t.openai, { stream: t.stream, chain: plan.chain, lane: plan.lane, overflow: plan.overflow })
  const extra = { 'X-Jell0-Routed': res.headers.get('X-Jell0-Routed'), 'X-Jell0-Lane': plan.lane }
  if (!res.ok) {
    let msg = 'jell0: no Cloudflare model could answer.'
    try { msg = (await res.json()).error.message || msg } catch {}
    return withHeaders(anthropicError(res.status, anthropicType(res.status), msg), { ...extra, 'x-should-retry': res.headers.get('x-should-retry') })
  }
  const stops = t.openai.stop || []
  if (t.stream) {
    return new Response(openAISSEToAnthropicSSE(res.body, t.requestedModel, { stops }), {
      headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', ...extra },
    })
  }
  return json(openAIToAnthropic(await res.json(), t.requestedModel, stops), 200, extra)
}

async function count(request, env) {
  const refused = await admit(request, env, { keyLimit: false }) // runs no model
  if (refused) return anthropicRefusal(refused)
  const body = await readJson(request)
  if (!body) return anthropicError(400, 'invalid_request_error', 'Request body must be a JSON object.')
  return json(countTokens(body))
}

// ---------------------------------------------------------------- admin

async function keysApi(request, env, url) {
  if (request.method === 'GET') {
    const keys = [
      ...(await listKvKeys(env)).map(k => ({ id: k.id, label: k.label, created: k.created || null, hint: k.hint ? '...' + k.hint : '', stored: 'sha256' })),
      ...(await loadOldKeys(env)).map(k => ({
        id: k.id,
        label: k.label,
        created: k.created || null,
        hint: typeof k.key === 'string' ? '...' + k.key.slice(-4) : '',
        stored: 'old api_keys list (made by the old, open jell0; NOT accepted; delete it)',
      })),
    ]
    return json({ ok: true, keys })
  }
  if (request.method === 'POST') {
    const b = await readJson(request)
    if (!b) return json({ ok: false, error: 'bad json' }, 400)
    const label = String(b.label || 'Unnamed agent').trim().slice(0, 100) || 'Unnamed agent'
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    const key = 'jell0-' + [...bytes].map(x => x.toString(16).padStart(2, '0')).join('')
    const entry = { id: crypto.randomUUID(), label, hint: key.slice(-4), created: new Date().toISOString() }
    await addKvKey(env, await sha256hex(key), entry)
    return json({ ok: true, id: entry.id, label, created: entry.created, key, note: 'Shown once. jell0 keeps only its SHA-256.' })
  }
  const id = url.searchParams.get('id')
  if (!id) return json({ ok: false, error: 'id required' }, 400)
  return json({ ok: true, removed: await deleteKvKey(env, id) })
}

// why: say why admin is off (GET /api/jell0/session only). Never the token.
async function admin(request, env, fn, { why = false } = {}) {
  if (!await adminOk(env, request)) return json({ ok: false, error: (why && adminOff(env)) || 'admin token required' }, 401)
  return fn()
}

// ---------------------------------------------------------------- routing

function select(url) {
  const prompt = url.searchParams.get('prompt') || ''
  const pref = url.searchParams.get('pref') || 'smart'
  const plan = planRoute({ model: pref, messages: [{ role: 'user', content: prompt }] }, {}, Date.now())
  return json({ preference: pref, lane: plan.lane, category: plan.category, chain: plan.chain, pick: plan.chain[0] || null })
}

async function route(request, env) {
  const url = new URL(request.url)
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const method = request.method
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (method === 'GET') {
    if (p === '/') return json(ABOUT)
    if (p === '/health') return new Response('ok', { headers: { ...CORS, 'Content-Type': 'text/plain' } })
    if (p === '/models' || p.endsWith('/models')) return json({ object: 'list', data: modelList(Date.now()) })
    if (p === '/select') return select(url)
  }
  if (method === 'POST') {
    if (p.endsWith('/chat/completions')) return chat(request, env)
    if (p === '/v1/messages' || p === '/messages') return messages(request, env)
    if (p === '/v1/messages/count_tokens' || p === '/messages/count_tokens') return count(request, env)
  }
  if (p === '/keys' || p.startsWith('/keys/api/')) {
    const r = await keyPage(request, env, url, p)
    if (r) return r
  }
  if (p === '/api/jell0/keys' && ['GET', 'POST', 'DELETE'].includes(method)) return admin(request, env, () => keysApi(request, env, url))
  if (p === '/api/jell0/session' && method === 'GET') return admin(request, env, () => json({ ok: true, authed: true, via: 'admin token' }), { why: true })
  return openaiError(404, 'Not found.', 'invalid_request_error', 'not_found')
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env)
    } catch {
      if (new URL(request.url).pathname.includes('/messages')) return anthropicError(500, 'api_error', 'jell0 internal error.')
      return openaiError(500, 'jell0 internal error.', 'server_error', 'internal_error')
    }
  },
}
