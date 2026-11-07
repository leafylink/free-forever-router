// Who may call jell0. Model routes take only a key that is (i) a KV entry
// "key:<sha256 of the key>", made by this jell0's admin API, or (ii) a
// LeafyLink Manager API key whose only permission is "ai_models". Nothing else:
// the shared bearer the box used before this rebuild is not accepted. Admin
// routes take only Authorization: Bearer <JELL0_ADMIN_TOKEN>, and only when that
// token has the v2 format. JELL0_ADMIN_TOKEN is the only secret jell0 reads; no
// key value is ever logged or returned.

// The live jell0 this replaces kept an admin token anyone could read, under this
// same secret name, and wrangler deploy keeps old secrets. So admin works only
// with a token in a format the old one cannot have: "jell0-admin-v2." plus at
// least 40 letters, digits, "-" or "_" (README, Before the first deploy, step 2).
const ADMIN_TOKEN = /^jell0-admin-v2\.[A-Za-z0-9_-]{40,}$/
const CACHE_MS = 60 * 1000
const CACHE_MAX = 1000
// Manager keys are "llk_" plus hex (leafylink-manager src/lib/apikey.js).
// Anything else never reaches D1.
const MANAGER_KEY = /^llk_[0-9A-Za-z]{32,128}$/
// Permissions that open nothing in the Manager itself (the Manager's
// KEY_ONLY_PERMS). jell0 takes a Manager key only when every permission it has
// is one of these, so the key a client holds cannot also open the Manager API.
const KEY_ONLY_PERMS = ['ai_models']
const KV_KEY_PREFIX = 'key:'
const OLD_LIST = 'api_keys' // the old jell0's list: listed and deletable, never accepted

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Constant-time compare for strings of equal length (hex digests here).
export function safeEqual(a, b) {
  a = String(a)
  b = String(b)
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

// Compare two secrets through their SHA-256, so neither length nor content leaks.
export async function sameSecret(a, b) {
  return safeEqual(await sha256hex(a), await sha256hex(b))
}

function bearerOf(request) {
  const h = request.headers.get('Authorization') || ''
  return /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, '').trim() : ''
}

export function keyFromRequest(request) {
  return bearerOf(request) || (request.headers.get('x-api-key') || '').trim()
}

// ---------------------------------------------------------------- admin

function adminToken(env) {
  const t = env.JELL0_ADMIN_TOKEN
  return typeof t === 'string' ? t : ''
}

// Why admin is off, or null when it is on. Never includes the token.
export function adminOff(env) {
  const t = adminToken(env)
  if (!t) return 'admin is off: JELL0_ADMIN_TOKEN is not set.'
  if (!ADMIN_TOKEN.test(t)) {
    return 'admin is off: JELL0_ADMIN_TOKEN is not in the v2 format ("jell0-admin-v2." plus 40 or more random letters or digits). Set a fresh one (README, Before the first deploy, step 2).'
  }
  return null
}

// Admin works only with a v2 JELL0_ADMIN_TOKEN, compared in constant time.
export async function adminOk(env, request) {
  if (adminOff(env)) return false
  const given = bearerOf(request)
  if (!given) return false
  return sameSecret(given, adminToken(env))
}

// ---------------------------------------------------------------- KV keys

// Each key made by this jell0's admin API is its own KV entry,
// "key:<sha256 of the key>", holding { id, label, hint, created } (also as
// metadata, so a list shows it). Making or deleting one key never rewrites
// another, so two admin calls at once cannot undo each other.

export async function addKvKey(env, hash, entry) {
  await env.JELL0_CONFIG.put(KV_KEY_PREFIX + hash, JSON.stringify(entry), { metadata: entry })
}

export async function listKvKeys(env) {
  const out = []
  let cursor
  do {
    const page = await env.JELL0_CONFIG.list({ prefix: KV_KEY_PREFIX, cursor })
    for (const k of page.keys || []) out.push({ name: k.name, ...(k.metadata || {}) })
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}

// The old jell0's single "api_keys" list. Its entries hold the key itself and
// are NOT accepted: its admin API was open to anyone, so any of them may be a
// stranger's. They stay listed (GET /api/jell0/keys) so the owner can delete them.
export async function loadOldKeys(env) {
  try {
    const raw = await env.JELL0_CONFIG.get(OLD_LIST)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter(k => k && typeof k === 'object') : []
  } catch {
    return []
  }
}

// Delete every key with this id; returns how many went.
export async function deleteKvKey(env, id) {
  let removed = 0
  for (const k of await listKvKeys(env)) {
    if (k.id === id) { await env.JELL0_CONFIG.delete(k.name); removed++ }
  }
  const old = await loadOldKeys(env)
  const left = old.filter(k => k.id !== id)
  if (left.length !== old.length) {
    await env.JELL0_CONFIG.put(OLD_LIST, JSON.stringify(left))
    removed += old.length - left.length
  }
  return removed
}

// One KV read: the entry named for the key's SHA-256. A KV error means no.
export async function kvKeyOk(env, key) {
  if (!key) return false
  try {
    return (await env.JELL0_CONFIG.get(KV_KEY_PREFIX + await sha256hex(key))) !== null
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- Manager keys

const managerCache = new Map() // sha256 of key -> { ok, at }

export function clearKeyCache() {
  managerCache.clear()
}

// A Manager API key works when its SHA-256 is in mgr_api_key, it is not
// revoked, and "ai_models" is its only permission. jell0 only reads (the
// binding itself could write); results are kept
// 60 s (least recently used dropped first when full). Any D1 error means not valid (and is
// not cached). A key not shaped like a Manager key is refused before D1.
export async function managerKeyOk(env, key) {
  if (!key || !MANAGER_KEY.test(key) || !env.MGR_DB) return false
  const hash = await sha256hex(key)
  const hit = managerCache.get(hash)
  if (hit && Date.now() - hit.at < CACHE_MS) {
    managerCache.delete(hash) // most recently used goes last, so it is dropped last
    managerCache.set(hash, hit)
    return hit.ok
  }
  let ok = false
  try {
    const row = await env.MGR_DB
      .prepare('SELECT perms FROM mgr_api_key WHERE hash = ?1 AND revoked_at IS NULL LIMIT 1')
      .bind(hash)
      .first()
    const perms = row ? String(row.perms || '').split(',').map(s => s.trim()).filter(Boolean) : []
    ok = perms.length > 0 && perms.every(p => KEY_ONLY_PERMS.includes(p))
  } catch {
    return false
  }
  managerCache.delete(hash)
  while (managerCache.size >= CACHE_MAX) managerCache.delete(managerCache.keys().next().value)
  managerCache.set(hash, { ok, at: Date.now() })
  return ok
}

// ---------------------------------------------------------------- model routes

// Which kind of key the request carries: 'kv', 'manager', or null.
// Bearer or x-api-key. The admin token is never a model key.
export async function keyKind(env, request) {
  const key = keyFromRequest(request)
  if (!key) return null
  const t = adminToken(env)
  if (t && await sameSecret(key, t)) return null
  if (await kvKeyOk(env, key)) return 'kv'
  if (await managerKeyOk(env, key)) return 'manager'
  return null
}

export async function modelKeyOk(env, request) {
  return (await keyKind(env, request)) !== null
}

// ---------------------------------------------------------------- rate limits

// true when a Workers Rate Limiting binding says this key is over its limit.
// No binding (tests, local dev) means no limit; wrangler.toml declares both.
export async function overLimit(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return false
  try {
    const { success } = await binding.limit({ key })
    return success === false
  } catch {
    return false
  }
}
