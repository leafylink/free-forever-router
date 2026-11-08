// The jell0 key page (owner, 2026-11-08: "Create a new UI for me to be able to mint tokens from
// jell0"). GET /keys serves the page; /keys/api/* does the work. Everything lives in jell0's own
// D1 (binding JELL0_DB): jell0_admin (one password, PBKDF2), jell0_setup (the one-time window in
// which the password may be chosen), jell0_sessions (sign-ins), jell0_keys (the keys, SHA-256 only).
// A minted key is shown once and never stored in the clear.

import { sha256hex, safeEqual, overLimit } from './keys.js'

const enc = new TextEncoder()
const COOKIE = 'jell0_session'
const SESSION_HOURS = 12
const PBKDF2_ITER = 100000

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomHex(n) {
  return hex(crypto.getRandomValues(new Uint8Array(n)))
}

export async function pbkdf2(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)))
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256))
}

function out(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  })
}

function cookieOf(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([0-9a-f]{64})'))
  return m ? m[1] : ''
}

function sessionCookie(token, maxAge) {
  return COOKIE + '=' + token + '; Path=/keys; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge
}

async function body(request) {
  try {
    const b = await request.json()
    return b && typeof b === 'object' ? b : {}
  } catch {
    return {}
  }
}

async function state(db) {
  const admin = await db.prepare('SELECT pw_hash, salt FROM jell0_admin WHERE id = 1').first()
  const setup = await db.prepare("SELECT 1 AS open FROM jell0_setup WHERE id = 1 AND open_until > datetime('now')").first()
  return { admin, setupOpen: !admin && !!setup }
}

async function signedIn(db, request) {
  const t = cookieOf(request)
  if (!t) return false
  const row = await db.prepare("SELECT 1 AS ok FROM jell0_sessions WHERE token_hash = ?1 AND expires_at > datetime('now')")
    .bind(await sha256hex(t)).first()
  return !!row
}

async function newSession(db) {
  const token = randomHex(32)
  await db.prepare("DELETE FROM jell0_sessions WHERE expires_at <= datetime('now')").run()
  await db.prepare("INSERT INTO jell0_sessions (token_hash, expires_at) VALUES (?1, datetime('now', ?2))")
    .bind(await sha256hex(token), '+' + SESSION_HOURS + ' hours').run()
  return out({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_HOURS * 3600) })
}

// Same-origin check for every POST: the page only ever posts to itself.
function sameOrigin(request, url) {
  const o = request.headers.get('Origin')
  return !o || o === url.origin
}

export async function keyPage(request, env, url, p) {
  if (p === '/keys' && request.method === 'GET') {
    return new Response(PAGE, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'X-Frame-Options': 'DENY',
      },
    })
  }
  const db = env.JELL0_DB
  if (!db) return out({ ok: false, error: 'the key database is not connected' }, 503)
  if (!p.startsWith('/keys/api/')) return null
  const what = p.slice('/keys/api/'.length)
  if (request.method === 'POST' && !sameOrigin(request, url)) return out({ ok: false, error: 'wrong origin' }, 403)
  // Same per-IP limit as the model routes, before any password work.
  if (request.method === 'POST' && await overLimit(env.JELL0_IP_LIMIT, 'keys:' + (request.headers.get('CF-Connecting-IP') || 'unknown'))) {
    return out({ ok: false, error: 'too many tries, wait a minute' }, 429)
  }

  if (what === 'state' && request.method === 'GET') {
    const s = await state(db)
    return out({ ok: true, hasPassword: !!s.admin, setupOpen: s.setupOpen, signedIn: await signedIn(db, request) })
  }

  if (what === 'setup' && request.method === 'POST') {
    const s = await state(db)
    if (s.admin) return out({ ok: false, error: 'a password is already set' }, 409)
    if (!s.setupOpen) return out({ ok: false, error: 'setup is closed' }, 403)
    const { password } = await body(request)
    if (typeof password !== 'string' || password.length < 12) return out({ ok: false, error: 'use at least 12 characters' }, 400)
    const salt = randomHex(16)
    const r = await db.prepare('INSERT OR IGNORE INTO jell0_admin (id, pw_hash, salt) VALUES (1, ?1, ?2)')
      .bind(await pbkdf2(password, salt), salt).run()
    if (!r.meta || r.meta.changes !== 1) return out({ ok: false, error: 'a password is already set' }, 409)
    await db.prepare('DELETE FROM jell0_setup').run()
    return newSession(db)
  }

  if (what === 'login' && request.method === 'POST') {
    const s = await state(db)
    if (!s.admin) return out({ ok: false, error: 'no password is set yet' }, 403)
    const { password } = await body(request)
    if (typeof password !== 'string' || !password) return out({ ok: false, error: 'wrong password' }, 401)
    if (!safeEqual(await pbkdf2(password, s.admin.salt), s.admin.pw_hash)) return out({ ok: false, error: 'wrong password' }, 401)
    return newSession(db)
  }

  if (!(await signedIn(db, request))) return out({ ok: false, error: 'sign in first' }, 401)

  if (what === 'logout' && request.method === 'POST') {
    await db.prepare('DELETE FROM jell0_sessions WHERE token_hash = ?1').bind(await sha256hex(cookieOf(request))).run()
    return out({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) })
  }

  if (what === 'list' && request.method === 'GET') {
    const r = await db.prepare('SELECT hash, label, hint, created_at, revoked_at FROM jell0_keys ORDER BY created_at DESC').all()
    return out({ ok: true, keys: (r.results || []).map(k => ({ id: k.hash.slice(0, 12), label: k.label, hint: k.hint, created: k.created_at, revoked: k.revoked_at })) })
  }

  if (what === 'mint' && request.method === 'POST') {
    const { label } = await body(request)
    const name = String(label || '').trim().slice(0, 100)
    if (!name) return out({ ok: false, error: 'give the key a name' }, 400)
    const key = 'jell0-' + randomHex(32)
    await db.prepare('INSERT INTO jell0_keys (hash, label, hint) VALUES (?1, ?2, ?3)').bind(await sha256hex(key), name, key.slice(-4)).run()
    return out({ ok: true, key, label: name })
  }

  if (what === 'revoke' && request.method === 'POST') {
    const { id } = await body(request)
    if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return out({ ok: false, error: 'bad id' }, 400)
    const r = await db.prepare("UPDATE jell0_keys SET revoked_at = datetime('now') WHERE substr(hash, 1, 12) = ?1 AND revoked_at IS NULL").bind(id).run()
    return out({ ok: true, revoked: (r.meta && r.meta.changes) || 0 })
  }

  return out({ ok: false, error: 'not found' }, 404)
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>jell0 keys</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1b1b1b;--muted:#666;--line:#e3e3df;--accent:#1f7a4d;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#eee;--muted:#9a9a9a;--line:#333;--accent:#4cc38a;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);width:100%}
button{font:inherit;padding:8px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}button.bad{background:var(--bad)}
.row{display:flex;gap:8px;align-items:center}.row input{flex:1}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);font-size:14px}
th{color:var(--muted);font-weight:500}.off{color:var(--muted);text-decoration:line-through}
.key{font-family:ui-monospace,monospace;word-break:break-all;background:var(--bg);padding:10px;border-radius:8px;border:1px dashed var(--accent)}
.err{color:var(--bad);min-height:1.5em}.hide{display:none}.top{display:flex;justify-content:space-between;align-items:start;gap:8px}
</style></head><body><main>
<div class="top"><div><h1>jell0 keys</h1><p class="sub">Keys for agents and projects to use jell0 (Cloudflare models only).</p></div>
<button id="out" class="ghost hide">Sign out</button></div>

<div id="setup" class="card hide"><b>Choose a password</b><p class="sub">First visit: pick the password for this page (12+ characters).</p>
<div class="row"><input id="pw1" type="password" autocomplete="new-password" placeholder="New password"><button id="setbtn">Set</button></div></div>

<div id="login" class="card hide"><b>Sign in</b>
<div class="row" style="margin-top:8px"><input id="pw" type="password" autocomplete="current-password" placeholder="Password"><button id="inbtn">Sign in</button></div></div>

<div id="closed" class="card hide">No password is set and setup is closed. Ask your agent to open setup again.</div>

<div id="app" class="hide">
<div class="card"><b>Make a key</b>
<div class="row" style="margin-top:8px"><input id="label" placeholder="Who is it for (for example: box cataloger)"><button id="mint">Make key</button></div>
<div id="new" class="hide" style="margin-top:12px"><p class="sub" style="margin:0 0 6px">Copy it now. It is shown only once.</p>
<div class="key" id="newkey"></div><div class="row" style="margin-top:8px"><button id="copy" class="ghost">Copy</button></div></div></div>
<div class="card"><b>Keys</b><table><thead><tr><th>Name</th><th>Ends</th><th>Made</th><th></th></tr></thead><tbody id="list"></tbody></table></div>
</div>
<p class="err" id="err"></p>
</main><script>
const $=id=>document.getElementById(id);const show=(id,on)=>$(id).classList.toggle('hide',!on);
async function api(path,data){const r=await fetch('/keys/api/'+path,data?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{});const j=await r.json().catch(()=>({ok:false,error:'no answer'}));if(!j.ok)throw new Error(j.error||'failed');return j}
function err(e){$('err').textContent=e?e.message||String(e):''}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function load(){err();const s=await api('state');show('setup',!s.hasPassword&&s.setupOpen);show('closed',!s.hasPassword&&!s.setupOpen);show('login',s.hasPassword&&!s.signedIn);show('app',s.signedIn);show('out',s.signedIn);if(s.signedIn)await list()}
async function list(){const j=await api('list');$('list').innerHTML=j.keys.map(k=>'<tr class="'+(k.revoked?'off':'')+'"><td>'+esc(k.label)+'</td><td>...'+esc(k.hint)+'</td><td>'+esc((k.created||'').slice(0,16))+'</td><td>'+(k.revoked?'retired':'<button class="bad" data-id="'+esc(k.id)+'">Retire</button>')+'</td></tr>').join('')||'<tr><td colspan="4" class="sub">No keys yet.</td></tr>'}
$('setbtn').onclick=()=>api('setup',{password:$('pw1').value}).then(load,err);
$('inbtn').onclick=()=>api('login',{password:$('pw').value}).then(()=>{$('pw').value='';return load()},err);
$('pw').onkeydown=e=>{if(e.key==='Enter')$('inbtn').click()};
$('out').onclick=()=>api('logout',{}).then(load,err);
$('mint').onclick=()=>api('mint',{label:$('label').value}).then(j=>{$('newkey').textContent=j.key;show('new',true);$('label').value='';return list()},err);
$('copy').onclick=()=>navigator.clipboard.writeText($('newkey').textContent).then(()=>{$('copy').textContent='Copied'});
$('list').onclick=e=>{const id=e.target.dataset&&e.target.dataset.id;if(id&&confirm('Retire this key? Anything using it stops working.'))api('revoke',{id}).then(list,err)};
load().catch(err);
</script></body></html>`
