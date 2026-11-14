# magpie-cf-media — Cloudflare Workers AI's non-chat models, as a Magpie plugin

Install it the way any git-hosted magpie plugin is installed:

```sh
magpie plugin add github:jiangxh/magpie-cf-media
```

The Cloudflare Workers AI plugin
([`@magpie-community/opencode-cloudflare-workers-ai-auth`](https://git.jxh.cc.cd/magpie-community/cloudflare-workers-ai))
signs in and serves **chat**. Cloudflare's OpenAI-compatible layer
(`/ai/v1`) serves chat alone, so whisper, flux and clef never reach magpie
through it. This plugin is that plugin's companion: it takes the same
accounts and serves what chat can't.

It **declares no model id of its own**. Every read asks the account's live
Workers AI list what it serves and files each answer by the task Cloudflare
files it under, so a model Cloudflare publishes later appears on the next
read, and one it drops leaves.

## What it serves

| Slot | Where it lands | As |
| --- | --- | --- |
| `transcription` | `POST /v1/audio/transcriptions` | whisper, whisper-tiny-en, whisper-large-v3-turbo, deepgram nova-3 / flux |
| `speech` | `POST /v1/audio/speech` | melotts, deepgram aura-1 / aura-2-en / aura-2-es |
| `image` | `POST /v1/images/generations` | flux-1-schnell, flux-2-dev, flux-2-klein-4b / 9b, SDXL, dreamshaper, leonardo… |
| `embedding` | `POST /v1/embeddings` | bge-m3, bge-*, qwen3-embedding, embeddinggemma, plamo |
| `decides` | `POST /v1/systemone` | clef, clef-flash, clef-omni |

The slot comes from `task.name` (the search API's `task.id` is a UUID), with
a name check only inside "Text Generation", the one task every model shares.
Two traps that shaped the rules:

- `@cf/cloudflare/clef` is filed under **Text Generation**, the same task as
  every chat model — so a decision model is found by its name, inside that
  task, and chat models are left alone.
- `@cf/deepgram/flux` is **Automatic Speech Recognition** despite the name —
  so a name never overrides the task.

## Accounts: nothing entered twice

It reads the accounts magpie already holds for the Cloudflare plugin, from
`<config>/plugin-auth.json` (`cloudflare-workers-ai` and its `#<slot>`
siblings). All of an account's keys are used: a request asks each in turn,
one refused with 401/403/429 rests five minutes and the next answers.

## The Workers AI run calls it makes

| Route in (OpenAI) | Call out (Workers AI) |
| --- | --- |
| `{file, model}` multipart | `POST /ai/run/<id>` `{audio: <base64 string>}` → `{text}` |
| `{input, voice}` | `POST /ai/run/<id>` `{prompt}` → base64 audio as the body |
| `{input}` | `POST /ai/run/<id>` `{text}` per input → `{data: [vector]}` |
| `{prompt, size}` | `POST /ai/run/<id>` `{prompt}` → `{image: base64}` |
| `{state, questions}` | `POST /ai/run/<id>` with `model` as the **bare family name** |

Three things a live check settled (2026-11-14) that the code depends on:

1. **The path is the full id, even for clef.** `/ai/run/@cf/cloudflare/clef`
   answers 200; `/ai/run/clef` and `/ai/run/cloudflare/clef` both answer
   400 `7000 No route for that URI`.
2. **The body's `model` is the bare family name.** Workers AI checks it
   against `^\s*(clef|clef-flash)\s*$` and refuses the full id with `5006`.
   So the path keeps the id and the body gets `clef` — the two differ, which
   is what `bareID` is for.
3. **The transcription's `audio` is a base64 string.** The byte array the
   older examples show is retired: it now answers 5006
   (`'string' not in 'array','binary'`), and a raw binary or multipart body
   answers 8001. A base64 string answers 200.

## Checking it against the live API

```sh
# where each model lands, from one account's own list
node verify-discovery.mjs [plugin-auth.json]

# the shapes, against real Workers AI calls
MAGPIE_CONFIG_DIR=<magpie config> node verify-live.mjs
```

## Sign-in

Nothing to type, ever. The credentials are the ones the Cloudflare Workers
AI plugin already holds: `accounts.mjs` reads them from magpie's store
(`plugin-auth.json`) and every request is handed all of them.

The sign-in this plugin declares is a **keyless** one — no field, no
prompt — whose `authorize` picks the first stored Cloudflare account, so
the only thing a user ever does is press Sign in once (or run
`magpie plugin login cf-media`, which asks nothing). A method is needed at
all because magpie keeps a provider with no sign-in out of its routing
catalog: an empty `methods` lists the models but refuses every call
("magpie knows no cf-media/… model"). The copy that sign-in saves is only
what makes the host count the provider as signed in; requests go through
the whole stored pool. With no Cloudflare account signed in there, the
sign-in says so and nothing is served until the Cloudflare plugin has one.

## Licence

MIT.