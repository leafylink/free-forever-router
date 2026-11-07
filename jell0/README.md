# jell0-router

jell0 is a Cloudflare-only LLM router. Every model call runs on an open model that Cloudflare hosts on
Workers AI, through the Worker's AI binding. There is no OpenRouter, Hugging Face, DeepSeek API,
OrcaRouter, Gemini, kilo or local model any more, and jell0 reads no provider key at all.

It speaks two formats:

- OpenAI Chat Completions (`/v1/chat/completions`) for OpenCode and anything OpenAI-compatible.
- Anthropic Messages (`/v1/messages`) for Claude Code.

Live host (workers.dev only, no routes or custom domains): `https://jell0-router.jonathan-d7a.workers.dev`

**Honest note.** No open model matches Claude Opus 5.5. The strongest coding model on Cloudflare is
GLM-5.3, which Z.ai calls the most capable open-weights coding model. Cloudflare says even the cheaper
GLM-5.3 Flash approaches Claude Opus 4.8 on coding and agentic benchmarks. jell0's flagship lane starts
with GLM-5.3 and falls back to DeepSeek V4.1 Flash and Qwen 3.8 27B.

## Models (src/catalog.js)

Facts from the Cloudflare docs on 2026-11-07. Prices are USD per million tokens. "Paid" models need the
Workers Paid plan (see Rate limits below).

| Alias | Workers AI id | Context | Tools | Vision | Reasoning | Input / cached / output | Plan, limit |
|---|---|---|---|---|---|---|---|
| glm-5.3, glm | @cf/zai-org/glm-5.3 | 1,048,576 | yes | no | low, high, max (default max) | $1.40 / $0.26 / $4.40 | paid, 20 rpm |
| deepseek-v4.1-flash, deepseek | @cf/deepseek-ai/deepseek-v4.1-flash-1017 | 1,048,576 | yes | yes | none, low, high, max (default high) | $0.30 / $0.006 / $1.20 | paid, 20 rpm |
| qwen3.8-27b, qwen | @cf/qwen/qwen3.8-27b | 262,144 | yes | yes | low, medium, xhigh (default) | $0.45 / $0.05 / $3.20 | 300 rpm |
| gemma-4-26b, gemma | @cf/google/gemma-4-26b-a4b-it | 256,000 | yes | yes | on or off (enable_thinking) | $0.10 / - / $0.30 | free plan, 300 rpm |
| gpt-oss-120b | @cf/openai/gpt-oss-120b | 128,000 | yes | no | low, medium, high | $0.35 / - / $0.75 | 300 rpm |
| gpt-oss-20b | @cf/openai/gpt-oss-20b | 128,000 | yes | no | low, medium (default), high | $0.20 / - / $0.30 | 300 rpm |
| glm-4.7-flash | @cf/zai-org/glm-4.7-flash | 131,072 | yes | no | yes | $0.0605 / - / $0.40 | free plan, 300 rpm |
| llama-4-scout | @cf/meta/llama-4-scout-17b-16e-instruct | 131,000 | yes | yes | no | $0.27 / - / $0.85 | 300 rpm |
| glm-5.2 | @cf/zai-org/glm-5.2 | 262,144 | yes | no | yes | $1.40 / $0.26 / $4.40 | paid, 20 rpm, retires Nov 20 2026 |

Rate limits: GLM-5.3, DeepSeek V4.1 Flash and GLM-5.2 need the Workers Paid plan and allow 20 requests
per minute per account, per model; the other models allow 300. Prepaid AI Gateway credits (and their
50 rpm limit) apply only to requests sent through an AI Gateway set to Unified billing, and jell0 calls
Workers AI without one. On a Free plan account the paid models answer 403 (5035) and jell0 moves on to
the next model, so the flagship lane quietly runs on Qwen.

When a model is rate limited (429) or busy, jell0 moves to the next model in the lane: every model but
the last is called with `rejectIfBusy`, so Workers AI answers "busy" (3040) at once instead of queueing
the request; the last model in the chain waits for capacity rather than fail.

Cost guard:

- The prompt (jell0's estimate) is capped at 200,000 tokens on every lane but `jell0-long`: a bigger
  prompt gets 400 `prompt_too_large` before any model call. At that cap, the input of one GLM-5.3 request
  costs about $0.28, on top of its output. `jell0-long` takes up to its models' context windows (1,048,576
  tokens on DeepSeek V4.1 Flash and GLM-5.3, about $0.31 or $1.47 of input).
- `max_tokens` is capped at 32,768 for every model (16,384 when the client sends none).
- Each key may make 60 model requests a minute, and each caller IP 120 (Workers Rate Limiting, per
  Cloudflare location, so it is approximate). Over either: 429 with `Retry-After`.
- GLM-5.3 reasons at "max" and Qwen at "xhigh" unless the client sends an effort; reasoning tokens are
  billed as output. The general lane starts with Qwen for its 300 rpm limit, and pays for that default.
- On `/v1/messages`, Claude Code's effort (`output_config.effort`, from `/effort`) is used as the reasoning
  effort, mapped to the nearest level each model takes. `thinking: {"type": "disabled"}` asks for the
  lowest effort the model takes (none on DeepSeek, low on GLM-5.3, thinking off on Gemma); with neither,
  adaptive or enabled thinking asks for "high", and no `thinking` at all leaves the model's default.

### Retirements on Nov 20 2026

Workers AI retires `@cf/zai-org/glm-5.2` at 2026-11-20T00:00:00Z. Until then it works by name only (it is
never picked automatically). From then on, requests that name glm-5.2 are served by glm-5.3 and it leaves
the model list. GLM-5.3 Flash also lists Nov 20 2026, so it is not in the catalog. The same day Workers AI
retires the other LLMs jell0 might have used, so none of them is in the catalog either: Kimi K2.6, Kimi
K2.7 Code, DeepSeek V4 Pro (0813), DeepSeek V4 Flash (0731), Nemotron 3 120B, QwQ 32B, Qwen3 30B A3B,
DeepSeek R1 Distill Qwen 32B, and Llama 3.1 8B (fp8), 3.2 1B and 3.2 3B. Requests to a retired model get
410 (5028). To change the catalog, edit the one table in `src/catalog.js`.

## Lanes

Ask for a lane with the model name `jell0-<lane>` (or `jell0` for the smart lane). Each lane is an ordered
chain; a model is skipped when the request needs something it lacks (tools, images), when the prompt is
bigger than its context, or when it is retired.

| Lane | Chain |
|---|---|
| flagship, max, glm, coding | glm-5.3, deepseek-v4.1-flash, qwen3.8-27b |
| reasoning | deepseek-v4.1-flash, gpt-oss-120b, qwen3.8-27b |
| long | deepseek-v4.1-flash, qwen3.8-27b, glm-5.3 (by context size; the only lane without the 200,000 token prompt cap) |
| vision | deepseek-v4.1-flash, qwen3.8-27b, gemma-4-26b, llama-4-scout |
| general, balanced, classic, creative | qwen3.8-27b, deepseek-v4.1-flash, gemma-4-26b |
| fast, simple, budget, free, flatline | gemma-4-26b, glm-4.7-flash, gpt-oss-20b |
| jell0 (smart, the default) | the old keyword classifier counts keyword matches and picks coding, reasoning, vision, long, creative, general or simple; any request with images goes to vision. It never runs glm-5.3: its coding uses deepseek-v4.1-flash, qwen3.8-27b, gemma-4-26b, its long uses deepseek-v4.1-flash, qwen3.8-27b, and the rest use the lane of that name |

- A model alias or Workers AI id (for example `glm-5.3` or `@cf/zai-org/glm-5.3`) uses that model first,
  then the rest of its lane. glm-5.3 runs only when it is asked for: by name, a lane named for it
  (flagship, max, glm, coding), a Claude opus or sonnet name, or as the long lane's last resort.
- On `/v1/messages`, Claude names map too: opus and sonnet names go to the flagship lane, haiku names
  to the fast lane.
- Any other unknown model name goes to the smart lane, as before.
- The `X-Jell0-Preference` header still picks a lane when it names one.
- A model fits only when the prompt plus the output budget (`max_tokens`, or 16,384 when none is sent)
  fit its context window.
- If nothing in the lane fits, jell0 tries the cheapest big-context models: DeepSeek V4.1 Flash, then
  Qwen 3.8 27B. It never moves a request to GLM-5.3 on its own. If no model can take it, jell0 answers
  400 `no_model_fits`. The estimate (about 4 characters a token) can be low, for example for Chinese or
  Japanese text; when every model in the chain then says the prompt is too long, jell0 tries those two
  models too (when their window is bigger), then answers 400 `context_length_exceeded`.
- Every "too big" answer (`prompt_too_large`, `no_model_fits`, `context_length_exceeded`) starts with
  `prompt is too long`, the wording Claude Code reads as a full context, so it compacts the conversation
  and tries again. The first two go on with `: N tokens > M maximum` (jell0's estimate). The third gives
  no count, because there jell0's estimate was too low to trust.
- A model that is busy, rate limited, failing (5xx), gone (410/5028) or too small for the prompt makes
  jell0 try the next one. Other answers, in OpenAI error JSON (Anthropic error JSON on `/v1/messages`):
  - 400 `invalid_request` when Workers AI calls the request itself invalid (3006 request too large, 5004
    invalid data, 3003 incomplete request and similar). No other model is tried, so a bad request costs
    one call. It carries `x-should-retry: false`.
  - 429 `rate_limit_exceeded` when every model in the chain was busy or rate limited, or when the key or
    caller is over jell0's own rate limit.
  - 502 `unreadable_reply` when a model answered in a shape jell0 cannot read. jell0 does not retry it on
    another model, and the reply carries `x-should-retry: false`, which the Anthropic and OpenAI SDKs and
    Claude Code obey. A client that retries any 5xx regardless (OpenCode's AI SDK does) runs, and pays
    for, the model again.
  - 503 `all_models_failed` otherwise. The old made-up "flatline" reply is gone.
- Every answer carries `X-Jell0-Routed: workersai/<model id>` (plus ` (fallback)` when it was not the
  first choice) and `X-Jell0-Lane`.
- Streams carry token usage: models with a Chat Completions schema are asked for it
  (`stream_options.include_usage`), so Claude Code's context meter and auto-compact keep working.
- `/v1/messages` streams tool calls as they arrive (one `input_json_delta` per piece) and sends a `ping`
  event every 15 s while nothing else goes out, so a long tool call is never silent.
- `tool_choice.disable_parallel_tool_use` (or `parallel_tool_calls: false`) is passed to models that take
  it, and jell0 also keeps only the first tool call in the reply.
- `stop_sequence` is reported only when the model says which stop string it hit; otherwise a stop on a
  stop sequence reads as `end_turn`.
- A model gets at most one system message, and only first (Qwen 3.5 and later refuse anything else):
  leading system messages (OpenCode sends two) are joined, and the text of a later one (Claude Code sends
  some mid-conversation) moves into the next user message as a `<system-reminder>`.
- In a `tool_result`, Claude Code's ToolSearch `tool_reference` blocks reach the model as "Tool loaded:
  <name>"; jell0 sends every tool anyway.

## Auth

Model routes (`/v1/chat/completions`, `/chat/completions`, `/v1/messages`, `/messages`,
`/v1/messages/count_tokens`) need `Authorization: Bearer <key>` or `x-api-key: <key>`, where the key is
one of exactly two kinds:

1. a jell0 key made by this jell0's admin API (below). Each is its own KV entry, `key:<SHA-256 of the
   key>`; the key itself is never stored. Entries in the old jell0's `api_keys` list are not accepted:
   its admin API was open to anyone, so any of them may be a stranger's. They stay listed so they can be
   deleted.
2. a LeafyLink Manager API key with ONLY the **AI models** permission (Manager: Agency Settings > API
   Keys). Such a key opens nothing in the Manager, so the key a client holds cannot open the Manager API
   too. A Manager key that also has any other permission (admin, production...) gets 401 here. jell0
   checks the key's SHA-256 against `mgr_api_key` in the LeafyLink D1 and caches the answer for 60 s.
   jell0 only reads it; the binding itself can write. Revoked keys and keys with other permissions are
   refused, and so is everything when D1 errors.

Both kinds reach every lane and model. Anything else is 401 (an OpenAI error, or an Anthropic error on
the Messages routes): no key, the admin token, and the shared bearer the box used with the old jell0,
which is no longer accepted anywhere. A key that is not shaped like a Manager key (`llk_...`) never
reaches D1, and a caller over the IP rate limit gets 429 before any KV or D1 lookup.

Admin routes need `Authorization: Bearer <JELL0_ADMIN_TOKEN>` (a Worker secret, compared in constant
time). It must have the v2 format: `jell0-admin-v2.` followed by at least 40 random letters, digits, `-`
or `_`. With no token, or any other value (the old jell0's token included), admin is off, and
`GET /api/jell0/session` says why. There is no login, password or cookie. `JELL0_ADMIN_TOKEN` is the only
secret jell0 reads.

## Endpoints

| Method and path | What it does |
|---|---|
| GET `/` | short JSON description |
| GET `/health` | `ok` |
| GET `/models`, `/v1/models` | OpenAI model list: `jell0`, `jell0-<lane>`, catalog aliases and ids (not retired). No key needed. |
| GET `/select?prompt=...&pref=...` | the chain a request would take; calls no model |
| POST `/v1/chat/completions`, `/chat/completions` | OpenAI Chat Completions, JSON or streaming. As with the old jell0, any path that ends in `/chat/completions` works (and GET on any path that ends in `/models`), so clients with another base path keep working. |
| POST `/v1/messages`, `/messages` | Anthropic Messages, JSON or streaming |
| POST `/v1/messages/count_tokens` | Anthropic token estimate |
| GET `/api/jell0/keys` | admin: list KV keys (label, hint, dates; never the key) |
| POST `/api/jell0/keys` `{"label":"..."}` | admin: make a KV key; the key is shown once |
| DELETE `/api/jell0/keys?id=...` | admin: delete a KV key |
| GET `/api/jell0/session` | admin: check the admin token; when admin is off, says why (never the token) |

Everything else is 404, including the old console and the old provider, discover, connect and login
endpoints.

## Setup (for later, when the owner connects jell0)

The box and OpenCode each need their own key first (the shared bearer the box used with the old jell0
gets 401 now). Use either kind (see Auth):

- **A Manager key** with ONLY the **AI models** permission: in the Manager, Agency Settings > API Keys.
  Tick nothing else. This can be made before jell0 is deployed.
- **A jell0 KV key** from the admin API, once this jell0 is deployed and `JELL0_ADMIN_TOKEN` is set.
  The key is shown once; jell0 keeps only its SHA-256:

  ```sh
  curl -s -X POST -H "Authorization: Bearer $JELL0_ADMIN_TOKEN" -H 'content-type: application/json' \
    -d '{"label":"opencode"}' https://jell0-router.jonathan-d7a.workers.dev/api/jell0/keys
  ```

Make one key per client (label it `box`, `opencode` and so on), so one can be deleted without
breaking the others. Keep it in an environment variable, never in a file you commit.

### OpenCode

Add a custom OpenAI-compatible provider to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "jell0-cf": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "jell0 (Cloudflare)",
      "options": {
        "baseURL": "https://jell0-router.jonathan-d7a.workers.dev/v1",
        "apiKey": "{env:JELL0_API_KEY}"
      },
      "models": {
        "jell0-flagship": { "name": "jell0 flagship (GLM-5.3 first)", "limit": { "context": 200000, "output": 32768 } },
        "glm-5.3": { "name": "GLM-5.3", "limit": { "context": 200000, "output": 32768 } },
        "deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash", "limit": { "context": 200000, "output": 32768 } },
        "qwen3.8-27b": { "name": "Qwen 3.8 27B", "limit": { "context": 200000, "output": 32768 } },
        "jell0-long": { "name": "jell0 long (DeepSeek first, no prompt cap)", "limit": { "context": 1048576, "output": 32768 } }
      }
    }
  },
  "model": "jell0-cf/jell0-flagship"
}
```

The 200,000 context limits match jell0's prompt cap, so OpenCode compacts before it reaches it. Pick
`jell0-long` only for work that needs a bigger prompt.

Then add the Ponytail plugin:

```sh
opencode plugin add @dietrichgebert/ponytail
```

### Claude Code

Set these in the shell (or in the `env` block of `~/.claude/settings.json`):

```sh
export ANTHROPIC_BASE_URL=https://jell0-router.jonathan-d7a.workers.dev
export ANTHROPIC_AUTH_TOKEN=<your jell0 KV key, or a Manager key with ONLY AI models>
export ANTHROPIC_MODEL=glm-5.3
export ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4.1-flash
export ANTHROPIC_DEFAULT_HAIKU_MODEL=gemma-4-26b
export CLAUDE_CODE_ATTRIBUTION_HEADER=0   # keeps the per-conversation attribution line out of the prompt
unset ANTHROPIC_API_KEY   # if it is set, Claude Code uses it instead of the token
```

jell0 has no web search (or any other Anthropic server tool): a request whose only tool is one gets 400.
So turn Claude Code's WebSearch off, or add a search MCP server instead. In `~/.claude/settings.json`:

```json
{ "permissions": { "deny": ["WebSearch"] } }
```

`/effort` works: jell0 maps it to the nearest reasoning level each model takes (low to max on GLM-5.3).

Then, inside Claude Code, add Ponytail:

```
/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail
```

## Deploy

Only through `.github/workflows/jell0-deploy.yml`, run by hand from the Actions tab, and only on the
owner's word. Its deploy job runs only when it is dispatched from `main` (from any other branch it is
skipped), so a stale branch cannot roll jell0 back. It runs the tests, deploys with `wrangler@4` using the repo secrets `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID`, then smoke tests the live host without a key (health, model list, 401 on
the model and admin routes, 404 on the removed endpoints). If the repo secret `JELL0_SMOKE_KEY` (a KV
key from the admin API, or a Manager key with only the AI models permission) is set, it also makes one keyed
call to `jell0-fast` with `max_tokens` 1 and checks that a Cloudflare model answered; the key is never
printed. The job fails if any check fails.
Never deploy jell0-router from the box or by hand: that would overwrite this code.

Bindings (wrangler.toml): `AI` (Workers AI), `JELL0_CONFIG` (KV: one `key:<sha256>` entry per key, and
the old `api_keys` list), `MGR_DB` (the LeafyLink D1; jell0 only reads it, but the binding itself can
write), `JELL0_IP_LIMIT` and `JELL0_KEY_LIMIT` (Workers Rate Limiting, 120 and 60 requests a minute; they
need wrangler 4.36 or newer, which `wrangler@4` gets). Secret: `JELL0_ADMIN_TOKEN` (optional; admin is
off without a v2 one).

### Before the first deploy (owner steps, in order)

The live jell0 this replaces had an open admin API: anyone could mint keys, and its discover endpoint
could send any Worker secret to any URL. So everything it held counts as leaked.

1. **Put the workflow on `main` by hand.** `.gitignore` ignores `.github/workflows/` (the push token has
   no workflow scope), so a normal `git add` leaves `jell0-deploy.yml` out without a warning, and GitHub
   only offers "Run workflow" for a file on the default branch. Add it in the GitHub web UI, or with
   `git add -f .github/workflows/jell0-deploy.yml` pushed by a token that has the workflow scope.
2. **Set a fresh `JELL0_ADMIN_TOKEN`** in the v2 format on jell0-router before the first run. Make one
   with `printf 'jell0-admin-v2.%s\n' "$(openssl rand -hex 32)"` and paste it into the Cloudflare dashboard
   (Workers, jell0-router, Settings, Variables and Secrets) or `npx wrangler secret put JELL0_ADMIN_TOKEN`.
   `wrangler deploy` keeps old secrets, so until this is done the old jell0's token stays bound; it does
   not have the `jell0-admin-v2.` start, so admin simply stays off (and `GET /api/jell0/session` says
   why) instead of trusting it.
3. **Clean the KV namespace `JELL0_CONFIG`.** Delete the `providers` entry (it held provider keys) and the
   `user` entry (the old login). The old `api_keys` entry can go too: jell0 never accepts its entries
   (after deploy, `/api/jell0/keys` lists them as `old api_keys list` so they can be deleted one by one).
4. **Know that the box gets 401 from the moment this deploys** until it has a new key: the shared bearer
   it used with the old jell0 is not accepted (see Auth). That is fine while jell0 is not connected.
   To connect the box and OpenCode later, give each a Manager key with only the AI models permission
   (can be made now) or a KV key from the admin API (after the deploy), as in Setup.
5. **Retire the other deploy path.** In leafylink-workers, branch `fix/deploy-workflow-2026-10-25` holds
   `.github/workflows/deploy-jell0-router.yml`, which deploys `workers/jell0-router.wrangler.toml`
   (also named jell0-router) on a push to `main`, or by hand from any branch, for example
   `ccr-e71dcf99-ggyn52`, which holds the old open-admin source. Running it would roll jell0 back.
   Delete that branch or disable that workflow, so only this jell0-deploy workflow deploys jell0-router.

### After the first deploy

`wrangler deploy` does not delete Worker secrets, so the old provider secrets stay bound to jell0-router.
Delete all five (dashboard, or `npx wrangler secret delete <NAME>`): `OPENROUTER_API_KEY`,
`HUGGINGFACE_TOKEN`, `DEEPSEEK_API_KEY`, `ORCAROUTER_API_KEY`, `GEMINI_API_KEY`. Then revoke those keys
at each provider: they may have leaked through the old discover endpoint. Only then is "jell0 holds no
provider secret" true of the deployed Worker, not just of this code.

## Tests

```sh
cd jell0 && npm test        # or, from the repo root: node --test jell0/test/*.test.mjs
```

Node 20 or newer, no dependencies. The tests use fake bindings only (KV map, AI mock, D1 mock) and call
no network.
