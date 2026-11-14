// Cloudflare Workers AI's non-chat models, as a Magpie plugin.
//
// The CF Workers AI plugin (@magpie-community/opencode-cloudflare-workers-ai-auth)
// signs in and serves chat. This is its companion for what that one can't
// serve through magpie's OpenAI-shaped routes: whisper and the other
// transcribers, flux and the other drawers, the embedders, and clef (System
// One). It holds no model list of its own: it asks the account's live
// Workers AI list what it serves and files each answer by its task, so a
// model Cloudflare publishes later is here on the next read.
//
// Sign-in: it reads the accounts magpie already holds for the CF plugin
// (`accounts.mjs`), so the same five tokens work here with nothing entered
// twice. One request per account is tried in turn; a refused account is
// rested and the next is asked, which is magpie's own habit for a provider
// with several keys.
//
// How a request arrives (docs/subsystems/provider-plugins.md):
//   /audio/transcriptions, /audio/speech, /embeddings — OpenAI-shaped under
//     the plugin's base (serveRetrieval).
//   /v1/images/generations — for a model `catalog.DrawsID` names while the
//     plugin speaks @ai-sdk/openai-compatible.
//   /v1/systemone — for a model marked `decides`, once the provider says
//     `decide: true`.
// Each is turned into the Workers AI run call the model wants, and the
// answer back into OpenAI's shape, since Cloudflare's OpenAI-compatible
// layer (/ai/v1) serves chat alone.

import {
  discoverModels,
  modelEntry,
  bareID,
} from "./discover.mjs";
import { cloudflareAccounts } from "./accounts.mjs";

const CF_MEDIA_ID = "cf-media";
const CF_API = "https://api.cloudflare.com/client/v4";
const CHAT_SDK = "@ai-sdk/openai-compatible";
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REST_MS = 5 * 60 * 1000; // an account refused waits this long

// A kept listing per account, with the moment it was read.
function createCache(ttlMs) {
  const kept = new Map();
  return {
    get(key) {
      const hit = kept.get(key);
      return hit && Date.now() - hit.at <= ttlMs ? hit.models : undefined;
    },
    set(key, models) {
      kept.set(key, { at: Date.now(), models });
      return models;
    },
  };
}

// Accounts that refused a request, and when they may be asked again.
const resting = new Map();

export async function CFMediaPlugin(input, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.discoveryTTLMs ?? DEFAULT_TTL_MS;
  const cache = createCache(ttlMs);

  // Where magpie keeps its config, for reading the sign-ins it already has.
  // The host hands a plugin its folder; the environment says it otherwise.
  const location = {
    location: input?.location ?? {
      directory: options.configDir ?? process.env.MAGPIE_CONFIG_DIR ?? process.cwd(),
    },
  };

  // The accounts this plugin serves, read from magpie's own store. Read
  // again whenever a listing is wanted, since a sign-in may have been added.
  const accounts = () => cloudflareAccounts(location);

  // One account's models, read live and kept for the TTL.
  const listingOf = async (account) => {
    const kept = cache.get(account.accountId);
    if (kept) return kept;
    const models = await discoverModels({
      accountId: account.accountId,
      apiKey: account.key,
      fetchImpl,
    });
    return cache.set(account.accountId, models);
  };

  // Every account's models, the union, so the list a group sees does not
  // depend on which account happens to be asked.
  const allModels = async () => {
    const all = accounts();
    if (!all.length) return [];
    const seen = new Map();
    for (const account of all) {
      let models;
      try {
        models = await listingOf(account);
      } catch {
        continue; // one account's refusal leaves the others' models listed
      }
      for (const m of models) if (!seen.has(m.id)) seen.set(m.id, m);
    }
    return [...seen.values()];
  };

  return {
    async config(cfg) {
      cfg.provider ??= {};
      const all = accounts();
      cfg.provider[CF_MEDIA_ID] ??= {
        name: "Cloudflare Workers AI · media",
        npm: CHAT_SDK,
        // The address a request goes under; the loader swaps in the
        // account that serves it, so the placeholder never reaches CF.
        api: `${CF_API}/accounts/\${CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
        // The decision models this provider serves make its /v1/systemone
        // address meaningful, which is what marks it as one that decides.
        decide: true,
        // Listed by the models hook per account, not fixed here.
        models: {},
      };
      if (all.length) {
        cfg.provider[CF_MEDIA_ID].accountNames = Object.fromEntries(
          all.map((a) => [a.label, a.accountId]),
        );
      }
    },

    auth: {
      provider: CF_MEDIA_ID,
      maxConcurrency: 3,
      // One keyless method: nothing to type. Its `authorize` reads an
      // account the Cloudflare Workers AI plugin already holds, so the
      // sign-in is a single click with no field (magpie's `keyless`,
      // provider-plugins.md: "GUI and CLI skip personal-key entry for it").
      // A method is needed at all because the host lists a provider with
      // no sign-in outside the routing catalog — an empty `methods` serves
      // models but refuses every call ("magpie knows no ... model").
      methods: [
        {
          type: "api",
          keyless: true,
          label: "Cloudflare accounts from the Workers AI plugin (nothing to enter)",
          async authorize() {
            const all = accounts();
            if (!all.length) {
              return {
                type: "failed",
                error: "sign in to the Cloudflare Workers AI plugin first: cf-media reads the accounts it holds",
              };
            }
            const first = all[0];
            return { type: "success", key: first.key, metadata: { accountId: first.accountId } };
          },
        },
      ],
      async loader(getAuth, _provider) {
        // The store's accounts are what is served — never the one
        // `authorize` saved, which is a copy of the first of them kept only
        // so the host counts this provider as signed in.
        const all = accounts();
        if (!all.length) {
          const own = await getAuth().catch(() => undefined);
          if (own && typeof own.key === "string" && /^[0-9a-f]{32}$/i.test(String(own.metadata?.accountId ?? ""))) {
            const accountId = String(own.metadata.accountId).toLowerCase();
            all.unshift({ id: CF_MEDIA_ID, key: own.key, accountId, label: accountId.slice(0, 6) });
          }
        }
        if (!all.length) {
          throw new Error(
            "cf-media reads the Cloudflare accounts the Workers AI plugin signed in; sign in there first",
          );
        }
        const first = all[0];
        return {
          baseURL: `${CF_API}/accounts/${first.accountId}/ai`,
          apiKey: first.key,
          // The fetch is handed every account, so a refusal on one is
          // answered by the next.
          async fetch(input, init) {
            return mediaFetch({ input, init, accounts: all, fetchImpl, allModels });
          },
        };
      },
    },

    // The models the accounts serve, filed by task. The host calls this for
    // the provider whose id it names, with the signed-in account.
    provider: {
      id: CF_MEDIA_ID,
      async models(_provider, _ctx) {
        const models = await allModels();
        return Object.fromEntries(models.map((m) => [m.id, modelEntry(m)]));
      },
    },
  };
}

// The Workers AI run URL is the model's full id for every slot, clef
// included. A live check (2026-11-14) of the three spellings:
//   POST /ai/run/@cf/cloudflare/clef  → 200 { result: { model: "clef", answers: {…} } }
//   POST /ai/run/clef                 → 400 7000 "No route for that URI"
//   POST /ai/run/cloudflare/clef      → 400 7000 "No route for that URI"
// Only the `model` field inside the body is the bare family name, which is
// why `decideModel` keeps it apart from the id.
function runPath(model, _slot) {
  return `/run/${model}`;
}

async function slotOfModel(allModels, model) {
  const models = await allModels();
  return models.find((m) => m.id === model)?.slot;
}

/**
 * Asks each account in turn until one answers. A refused one rests, so a
 * dead token is not asked on every request.
 */
async function askEach(accounts, doFetch) {
  const now = Date.now();
  const ready = accounts.filter((a) => (resting.get(a.accountId) ?? 0) <= now);
  const order = ready.length ? ready : accounts; // all resting: ask anyway
  let last;
  for (const account of order) {
    const res = await doFetch(account);
    if (res.ok) {
      resting.delete(account.accountId);
      return res;
    }
    last = res;
    // 401/403/429 are the account's; a 4xx about the request is the
    // request's and asking another account would fail the same way.
    if ([401, 403, 429].includes(res.status)) {
      resting.set(account.accountId, Date.now() + REST_MS);
      continue;
    }
    return res;
  }
  return last;
}

/** The plugin's fetch: OpenAI shape in, Workers AI run out, OpenAI shape back. */
async function mediaFetch({ input, init, accounts, fetchImpl, allModels }) {
  const req = new Request(input, init);
  const path = new URL(req.url).pathname;
  const contentType = req.headers.get("content-type") ?? "";

  // A transcription is multipart; every other route is JSON. The body is
  // read once, as the shape the route needs.
  let body = {};
  let audio;
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => undefined);
    const file = form?.get("file") ?? form?.get("audio");
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      audio = new Uint8Array(await file.arrayBuffer());
    }
    // The model may be a form field rather than JSON.
    if (form?.get("model")) body.model = String(form.get("model"));
  } else {
    const text = await req.text();
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
  }

  const model = String(body.model ?? "");
  if (!model) return jsonError(400, "cf-media: the request names no model");
  const slot = await slotOfModel(allModels, model);
  const headers = { "content-type": "application/json" };

  // A body for the run call, and how to turn its answer back.
  const run = async (slotForPath, runBody, back) => {
    const res = await askEach(accounts, (account) =>
      fetchImpl(`${CF_API}/accounts/${account.accountId}/ai${runPath(model, slotForPath)}`, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${account.key}` },
        body: JSON.stringify(runBody),
      }),
    );
    if (!res || !res.ok) return res ? passthrough(res) : jsonError(502, "cf-media: no account answered");
    const answer = await res.json().catch(() => ({}));
    return back(unwrapCF(answer));
  };

  if (path.endsWith("/audio/transcriptions") || path.endsWith("/transcriptions")) {
    if (!audio) return jsonError(400, "cf-media: the transcription carries no audio");
    // Workers AI takes the audio as base64 in a string (a 2026 change: it
    // used to take an array of byte numbers, and now answers an array with
    // 5006 "'string' not in 'array','binary'"). A base64 string answers 200.
    return run("transcription", { audio: base64Of(audio) }, (r) =>
      json(200, { text: String(r?.text ?? "") }),
    );
  }

  if (path.endsWith("/audio/speech") || path.endsWith("/speech")) {
    const prompt = String(body.input ?? body.text ?? "");
    if (!prompt) return jsonError(400, "cf-media: the speech request carries no input");
    return run("speech", { prompt }, (r) => {
      if (typeof r?.audio !== "string") return jsonError(502, "cf-media: the speech answer carries no audio");
      return new Response(Buffer.from(r.audio, "base64"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });
  }

  if (path.endsWith("/embeddings")) {
    const many = Array.isArray(body.input);
    const inputs = many ? body.input : [body.input ?? ""];
    const data = [];
    for (const [i, piece] of inputs.entries()) {
      const pieceText = typeof piece === "string" ? piece : String(piece?.text ?? "");
      const res = await askEach(accounts, (account) =>
        fetchImpl(`${CF_API}/accounts/${account.accountId}/ai${runPath(model, "embedding")}`, {
          method: "POST",
          headers: { ...headers, authorization: `Bearer ${account.key}` },
          body: JSON.stringify({ text: pieceText }),
        }),
      );
      if (!res || !res.ok) return res ? passthrough(res) : jsonError(502, "cf-media: no account answered");
      const answer = await res.json().catch(() => ({}));
      const r = unwrapCF(answer);
      // Workers AI answers one text's vector as { data: [[…]] } and a list's
      // as { data: […] }; both are read as one vector here.
      const v = Array.isArray(r?.data?.[0]) ? r.data[0] : r?.data;
      data.push({ object: "embedding", index: i, embedding: Array.isArray(v) ? v : [] });
    }
    return json(200, { object: "list", data, model, usage: { prompt_tokens: 0, total_tokens: 0 } });
  }

  if (path.endsWith("/images/generations")) {
    const prompt = String(body.prompt ?? "");
    if (!prompt) return jsonError(400, "cf-media: the image request carries no prompt");
    // Only what the caller said: each family keeps its own steps, guidance
    // and size defaults, which differ enough that guessing would be wrong.
    const runBody = { prompt };
    return run("image", runBody, (r) => {
      const b64 = r?.image ?? r?.images?.[0] ?? r?.data?.[0];
      if (typeof b64 !== "string") return jsonError(502, "cf-media: the image answer carries no image");
      return json(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }] });
    });
  }

  if (path.endsWith("/systemone")) {
    // magpie posts its System One body as it wrote it. Two things differ
    // from the other routes:
    //   - the body's `model` must be the bare family name: Workers AI checks
    //     it against ^\s*(clef|clef-flash)\s*$ and refuses "@cf/cloudflare/clef"
    //     with 5006 (the path keeps the full id — see runPath).
    //   - the answer goes back inside its envelope, for decide_wire's
    //     DecideAnswer to unwrap.
    const askBody = { ...body, model: slot === "decides" ? bareID(model) : model };
    return run("decides", askBody, (r) => json(200, r));
  }

  return jsonError(404, `cf-media serves no route for ${path}`);
}

// Workers AI answers { result: {...}, success: true, … }; `result` is the
// part that means anything.
function unwrapCF(answer) {
  if (answer && typeof answer === "object" && "result" in answer) return answer.result;
  return answer;
}

// Bytes as the base64 string Workers AI reads audio from.
function base64Of(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status, message) {
  return json(status, { error: { message, type: "cf_media_error" } });
}

// A refusal goes back as it came, so magpie's error path reads the vendor's
// own words rather than this plugin's.
async function passthrough(res) {
  const body = await res.text().catch(() => "");
  return new Response(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export default { id: CF_MEDIA_ID, setup: async (ctx) => CFMediaPlugin(ctx) };