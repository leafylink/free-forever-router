# How an agent wires up to jell0

jell0 is LeafyLink's LLM router. It runs ONLY on open models hosted by Cloudflare (Workers AI).
There is no OpenRouter, no Hugging Face, no local model, no other provider behind it. Do not add one.

- Address: `https://jell0-router.jonathan-d7a.workers.dev`
- Code: this folder (`jell0/`) of the `free-forever-router` repo (the router in the repo's top folder is a different,
  old Worker; ignore it). Deploy only through `.github/workflows/jell0-deploy.yml`, on the owner's word.

## 1. Get a key (self-serve, no person needed)

People: open https://jell0-router.jonathan-d7a.workers.dev/keys , sign in with the jell0 key-page
password, type a name and press Make key. The key is shown once.

Agents:

Any agent or project with Cloudflare access (wrangler with the account's API token, the Cloudflare
MCP, or a GitHub workflow that has `CLOUDFLARE_API_TOKEN`) makes its own key:

1. Make a random key locally, at least 32 characters, for example `jell0-` plus 64 hex characters:
   `KEY="jell0-$(openssl rand -hex 32)"`
2. Register only its SHA-256 in jell0's D1 database `jell0`
   (id `3926a761-94e6-4a41-a981-198c8427f01a`), table `jell0_keys`, with a label saying who you are:
   ```sh
   HASH=$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)
   npx wrangler d1 execute jell0 --remote \
     --command "INSERT INTO jell0_keys (hash, label) VALUES ('$HASH', 'box cataloger')"
   ```
   With the Cloudflare MCP: `d1_database_query` on that database id with the same INSERT.
3. Keep the key in your own private credential store (on the box: `~/.leafylink/creds.json`,
   block `jell0`; in a Worker: a secret; in GitHub: a repo secret). Never in a repo, log, doc or chat.
4. It works within about a minute. To retire a key:
   `UPDATE jell0_keys SET revoked_at = datetime('now') WHERE label = '...'`.

One key per agent or project, so one can be retired without breaking the rest. The old shared key
is dead (401).

## 2. Send it

Either header works:

- `Authorization: Bearer <key>`
- `x-api-key: <key>`

## 3. Endpoints

| Use | Method and path |
|---|---|
| OpenAI style chat (OpenCode, most agents) | `POST /v1/chat/completions` |
| Anthropic style (Claude Code) | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| Model list (no key needed) | `GET /v1/models` |
| Health (no key needed) | `GET /health` |
| Which models a prompt would use (no key) | `GET /select?prompt=...&pref=...` |

Streaming (`"stream": true`) and tool calls work on both styles.

## 4. Models

Ask for a lane or a model by name in `model`:

| Name | Runs on (in order, all Cloudflare) |
|---|---|
| `jell0-flagship`, `jell0-coding`, `glm-5.3` | GLM-5.3, then DeepSeek V4.1 Flash, then Qwen 3.8 27B |
| `jell0-reasoning` | DeepSeek V4.1 Flash, gpt-oss-120b, Qwen 3.8 |
| `jell0-vision` (images) | DeepSeek V4.1 Flash, Qwen 3.8, Gemma 4, Llama 4 Scout |
| `jell0-general` | Qwen 3.8, DeepSeek, Gemma 4 |
| `jell0-fast`, `jell0-budget`, `jell0-free` | Gemma 4, GLM-4.7 Flash, gpt-oss-20b |
| `jell0-long` | DeepSeek V4.1 Flash, Qwen 3.8 (1M context) |
| `jell0` (auto) | picks a lane from the prompt; never GLM-5.3 |

Claude Code names: `claude-opus-*` and `claude-sonnet-*` go to flagship, `claude-haiku-*` to fast.
The response header `X-Jell0-Routed` shows the model that answered (always `workersai/@cf/...`).

## 5. Limits

- Prompt up to about 200,000 tokens (more only on `jell0-long`); answer up to 32,768 tokens.
- 60 requests a minute per key, 120 per IP. Over that: 429, wait and retry.
- GLM-5.3 and DeepSeek allow 20 a minute account-wide; when busy, jell0 moves to the next model.

## 6. Examples

curl:

```sh
curl -s https://jell0-router.jonathan-d7a.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $JELL0_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"jell0-flagship","messages":[{"role":"user","content":"Say ok."}]}'
```

OpenCode (`opencode.json`), replacing any OpenRouter provider:

```json
{
  "provider": {
    "jell0": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "jell0 (Cloudflare)",
      "options": { "baseURL": "https://jell0-router.jonathan-d7a.workers.dev/v1", "apiKey": "<key>" },
      "models": {
        "jell0-flagship": { "name": "jell0 flagship (GLM-5.3)" },
        "jell0-fast": { "name": "jell0 fast (Gemma 4)" }
      }
    }
  }
}
```

Claude Code:

```sh
export ANTHROPIC_BASE_URL=https://jell0-router.jonathan-d7a.workers.dev
export ANTHROPIC_AUTH_TOKEN=<key>
export ANTHROPIC_MODEL=glm-5.3
```

Any OpenAI SDK: base URL `https://jell0-router.jonathan-d7a.workers.dev/v1`, api key = the key.

## 7. Errors

| Status | Meaning |
|---|---|
| 401 | No key, old shared key, or a key not registered (or revoked) in jell0_keys |
| 400 | Bad request or prompt too long (not retried) |
| 429 | Rate limit; wait and retry |
| 503 | No Cloudflare model could answer right now |

## Rules for agents

- Do not route jell0 traffic to OpenRouter or any other provider, and do not add one to jell0.
- Do not deploy jell0 from the box or by hand.
- One key per agent or device, so one can be deleted without breaking the rest.
