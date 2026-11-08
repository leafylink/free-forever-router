// The jell0 key page (owner, 2026-11-08: "Create a new UI for me to be able to mint tokens from
// jell0"). GET /keys serves the page; /keys/api/* does the work. Everything lives in jell0's own
// D1 (binding JELL0_DB): jell0_admin (one username and password, PBKDF2; a temporary password must be
// changed at first sign-in), jell0_sessions (sign-ins), jell0_keys (the keys, SHA-256 only, with the
// lanes each may use, an optional end date, and an on/off switch). Nothing here touches any other system.
// A minted key is shown once and never stored in the clear.

import { sha256hex, safeEqual, overLimit, clearKeyCache } from './keys.js'
import { LANE_NAMES } from './catalog.js'

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

async function admin(db) {
  return db.prepare('SELECT username, pw_hash, salt, must_change, temp_expires FROM jell0_admin WHERE id = 1').first()
}

async function session(db, request) {
  const tok = cookieOf(request)
  if (!tok) return null
  return db.prepare("SELECT must_change FROM jell0_sessions WHERE token_hash = ?1 AND expires_at > datetime('now')")
    .bind(await sha256hex(tok)).first()
}

async function newSession(db, mustChange) {
  const token = randomHex(32)
  await db.prepare("DELETE FROM jell0_sessions WHERE expires_at <= datetime('now')").run()
  await db.prepare("INSERT INTO jell0_sessions (token_hash, expires_at, must_change) VALUES (?1, datetime('now', ?2), ?3)")
    .bind(await sha256hex(token), '+' + SESSION_HOURS + ' hours', mustChange ? 1 : 0).run()
  return out({ ok: true, mustChange: !!mustChange }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_HOURS * 3600) })
}

function cleanLanes(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',')
  return [...new Set(list.map(s => String(s).trim().replace(/^jell0-/, '')).filter(s => LANE_NAMES.includes(s)))].join(',')
}

function cleanDays(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : 0
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
    const s = await session(db, request)
    return out({ ok: true, signedIn: !!s, mustChange: !!(s && s.must_change), lanes: LANE_NAMES })
  }

  if (what === 'login' && request.method === 'POST') {
    const a = await admin(db)
    const { username, password } = await body(request)
    if (!a || typeof password !== 'string' || !password || String(username || '').trim().toLowerCase() !== a.username) {
      return out({ ok: false, error: 'wrong username or password' }, 401)
    }
    if (!safeEqual(await pbkdf2(password, a.salt), a.pw_hash)) return out({ ok: false, error: 'wrong username or password' }, 401)
    if (a.must_change && a.temp_expires && a.temp_expires < new Date().toISOString().replace('T', ' ').slice(0, 19)) {
      return out({ ok: false, error: 'the temporary password has expired; ask your agent for a new one' }, 401)
    }
    return newSession(db, a.must_change)
  }

  const s = await session(db, request)
  if (!s) return out({ ok: false, error: 'sign in first' }, 401)

  if (what === 'logout' && request.method === 'POST') {
    await db.prepare('DELETE FROM jell0_sessions WHERE token_hash = ?1').bind(await sha256hex(cookieOf(request))).run()
    return out({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) })
  }

  if (what === 'password' && request.method === 'POST') {
    const { password } = await body(request)
    if (typeof password !== 'string' || password.length < 12) return out({ ok: false, error: 'use at least 12 characters' }, 400)
    const salt = randomHex(16)
    await db.prepare('UPDATE jell0_admin SET pw_hash = ?1, salt = ?2, must_change = 0, temp_expires = NULL WHERE id = 1')
      .bind(await pbkdf2(password, salt), salt).run()
    await db.prepare('DELETE FROM jell0_sessions').run() // every old sign-in ends
    return newSession(db, false)
  }

  if (s.must_change) return out({ ok: false, error: 'set a new password first' }, 403)

  if (what === 'list' && request.method === 'GET') {
    const r = await db.prepare('SELECT hash, label, hint, lanes, expires_at, disabled, created_at, revoked_at FROM jell0_keys ORDER BY created_at DESC').all()
    return out({ ok: true, keys: (r.results || []).map(k => ({ id: k.hash.slice(0, 12), label: k.label, hint: k.hint, lanes: k.lanes, expires: k.expires_at, disabled: !!k.disabled, created: k.created_at, revoked: k.revoked_at })) })
  }

  if (what === 'mint' && request.method === 'POST') {
    const { label, lanes, days } = await body(request)
    const name = String(label || '').trim().slice(0, 100)
    if (!name) return out({ ok: false, error: 'give the key a name' }, 400)
    const key = 'jell0-' + randomHex(32)
    const d = cleanDays(days)
    await db.prepare("INSERT INTO jell0_keys (hash, label, hint, lanes, expires_at) VALUES (?1, ?2, ?3, ?4, CASE WHEN ?5 > 0 THEN datetime('now', '+' || ?5 || ' days') END)")
      .bind(await sha256hex(key), name, key.slice(-4), cleanLanes(lanes), d).run()
    return out({ ok: true, key, label: name })
  }

  const { id, lanes, days, disabled } = request.method === 'POST' ? await body(request) : {}
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return out({ ok: false, error: 'bad id' }, 400)
  let r
  if (what === 'revoke' && request.method === 'POST') {
    r = await db.prepare("UPDATE jell0_keys SET revoked_at = datetime('now') WHERE substr(hash, 1, 12) = ?1 AND revoked_at IS NULL").bind(id).run()
  } else if (what === 'update' && request.method === 'POST') {
    const d = cleanDays(days)
    r = await db.prepare("UPDATE jell0_keys SET lanes = ?2, disabled = ?3, expires_at = CASE WHEN ?4 > 0 THEN datetime('now', '+' || ?4 || ' days') WHEN ?4 = 0 AND ?5 = 1 THEN NULL ELSE expires_at END WHERE substr(hash, 1, 12) = ?1 AND revoked_at IS NULL")
      .bind(id, cleanLanes(lanes), disabled ? 1 : 0, d, days === 0 || days === '0' ? 1 : 0).run()
  } else {
    return out({ ok: false, error: 'not found' }, 404)
  }
  clearKeyCache()
  return out({ ok: true, changed: (r.meta && r.meta.changes) || 0 })
}


const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>jell0 API token manager</title>
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
<div class="top"><div><h1>jell0 API token manager</h1><p class="sub">Tokens for agents and projects to use jell0. jell0 runs only on Cloudflare models.</p></div>
<button id="out" class="ghost hide">Sign out</button></div>

<div id="login" class="card hide"><b>Sign in</b>
<div style="display:grid;gap:8px;margin-top:8px"><input id="user" autocomplete="username" placeholder="Username">
<input id="pw" type="password" autocomplete="current-password" placeholder="Password"><div><button id="inbtn">Sign in</button></div></div></div>

<div id="change" class="card hide"><b>Set your own password</b><p class="sub">You signed in with a temporary password. Choose a new one (12+ characters).</p>
<div style="display:grid;gap:8px"><input id="np1" type="password" autocomplete="new-password" placeholder="New password">
<input id="np2" type="password" autocomplete="new-password" placeholder="New password again"><div><button id="setbtn">Save password</button></div></div></div>

<div id="app" class="hide">
<div class="card"><b>Make a token</b>
<div style="display:grid;gap:10px;margin-top:8px">
<input id="label" placeholder="Who is it for (for example: box cataloger)">
<div><span class="sub">Lanes it may use (none ticked = all):</span><div id="lanes" style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px"></div></div>
<div class="row"><span class="sub" style="white-space:nowrap">Ends after</span><input id="days" type="number" min="0" max="3650" placeholder="days (empty = never)" style="max-width:200px"></div>
<div><button id="mint">Make token</button></div></div>
<div id="new" class="hide" style="margin-top:12px"><p class="sub" style="margin:0 0 6px">Copy it now. It is shown only once.</p>
<div class="key" id="newkey"></div><div class="row" style="margin-top:8px"><button id="copy" class="ghost">Copy</button></div></div></div>
<div class="card"><b>Tokens</b><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Ends in</th><th>Lanes</th><th>Expires</th><th>State</th><th></th></tr></thead><tbody id="list"></tbody></table></div></div>
</div>
<p class="err" id="err"></p>
</main><script>
const $=id=>document.getElementById(id);const show=(id,on)=>$(id).classList.toggle('hide',!on);let LANES=[];
async function api(path,data){const r=await fetch('/keys/api/'+path,data?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{});const j=await r.json().catch(()=>({ok:false,error:'no answer'}));if(!j.ok)throw new Error(j.error||'failed');return j}
function err(e){$('err').textContent=e?e.message||String(e):''}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function load(){err();const s=await api('state');LANES=s.lanes||[];show('login',!s.signedIn);show('change',s.signedIn&&s.mustChange);show('app',s.signedIn&&!s.mustChange);show('out',s.signedIn);
$('lanes').innerHTML=LANES.map(l=>'<label><input type="checkbox" value="'+esc(l)+'" style="width:auto"> '+esc(l)+'</label>').join('');if(s.signedIn&&!s.mustChange)await list()}
async function list(){const j=await api('list');$('list').innerHTML=j.keys.map(k=>{const st=k.revoked?'retired':k.disabled?'off':'on';return '<tr class="'+(k.revoked?'off':'')+'"><td>'+esc(k.label)+'</td><td>...'+esc(k.hint)+'</td><td>'+esc(k.lanes||'all')+'</td><td>'+esc(k.expires?k.expires.slice(0,10):'never')+'</td><td>'+st+'</td><td style="white-space:nowrap">'+(k.revoked?'':'<button class="ghost" data-act="edit" data-id="'+esc(k.id)+'" data-lanes="'+esc(k.lanes)+'" data-off="'+(k.disabled?1:0)+'">Limits</button> <button class="ghost" data-act="toggle" data-id="'+esc(k.id)+'" data-lanes="'+esc(k.lanes)+'" data-off="'+(k.disabled?1:0)+'">'+(k.disabled?'Turn on':'Turn off')+'</button> <button class="bad" data-act="revoke" data-id="'+esc(k.id)+'">Retire</button>')+'</td></tr>'}).join('')||'<tr><td colspan="6" class="sub">No tokens yet.</td></tr>'}
$('inbtn').onclick=()=>api('login',{username:$('user').value,password:$('pw').value}).then(()=>{$('pw').value='';return load()},err);
$('pw').onkeydown=e=>{if(e.key==='Enter')$('inbtn').click()};
$('setbtn').onclick=()=>{if($('np1').value!==$('np2').value)return err(new Error('the two passwords differ'));api('password',{password:$('np1').value}).then(()=>{$('np1').value=$('np2').value='';return load()},err)};
$('out').onclick=()=>api('logout',{}).then(load,err);
$('mint').onclick=()=>{const lanes=[...document.querySelectorAll('#lanes input:checked')].map(i=>i.value);api('mint',{label:$('label').value,lanes,days:$('days').value}).then(j=>{$('newkey').textContent=j.key;show('new',true);$('label').value='';$('days').value='';document.querySelectorAll('#lanes input').forEach(i=>i.checked=false);return list()},err)};
$('copy').onclick=()=>navigator.clipboard.writeText($('newkey').textContent).then(()=>{$('copy').textContent='Copied'});
$('list').onclick=e=>{const b=e.target.closest('button');if(!b)return;const id=b.dataset.id,act=b.dataset.act;
if(act==='revoke'){if(confirm('Retire this token? Anything using it stops working.'))api('revoke',{id}).then(list,err)}
else if(act==='toggle'){api('update',{id,lanes:b.dataset.lanes,disabled:b.dataset.off!=='1'}).then(list,err)}
else if(act==='edit'){const l=prompt('Lanes this token may use, comma separated (empty = all). Lanes: '+LANES.join(', '),b.dataset.lanes||'');if(l===null)return;const d=prompt('End after how many days from now? 0 = never, empty = keep as is','');api('update',{id,lanes:l,disabled:b.dataset.off==='1',days:d===''?undefined:Number(d)}).then(list,err)}};
load().catch(err);
</script></body></html>`
