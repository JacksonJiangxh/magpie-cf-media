// Discovery of Cloudflare Workers AI's non-chat models.
//
// Nothing here names a model id: the Workers AI search API is asked for its
// whole list and each entry is sorted into a slot by the task Cloudflare
// files it under, with a name check only inside the one task id every model
// shares ("Text Generation", which is where clef sits too).
//
// The API, read live (2026-11-14, 75 entries on one account):
//   GET /client/v4/accounts/<account>/ai/models/search?per_page=200
//   → { success, result: [ { id: <uuid>, name: "@cf/…", description,
//        task: { id: <uuid>, name: "Text-to-Image", description }, … } ] }
// `task.id` is a UUID, so `task.name` is what is read.
//
// Two traps the live list showed, which is why the rules below read as they
// do:
//   - `@cf/cloudflare/clef` is filed under "Text Generation", the same task
//     as every chat model, so a decision model is found by its name and only
//     inside that task.
//   - `@cf/deepgram/flux` is an ASR model despite the name, so a name never
//     overrides the task: `flux` draws only when the task is Text-to-Image.

const CF_API = "https://api.cloudflare.com/client/v4";

// The task names this plugin files, as `task.name` spells them.
const TASK = {
  gen: "text generation",
  draw: "text-to-image",
  transcribe: "automatic speech recognition",
  speech: "text-to-speech",
  embed: "text embeddings",
  describe: "image-to-text",
};

// The words a decision model is called by. Cloudflare's family is
// clef / clef-flash / clef-omni; TypeSafe's jev answers the same questions
// through a plugin, and a later family is caught by the same words.
const DECIDE_WORDS = /(^|[/\-_])(clef|jev)([/\-_.]|$)|decision|system-?one/i;

// The slots this plugin serves, and the modalities each declares: what the
// host reads to know where a model may be sent.
const MODALITIES = {
  transcription: { input: ["audio"], output: ["text"] },
  speech: { input: ["text"], output: ["audio"] },
  image: { input: ["text"], output: ["image"] },
  embedding: { input: ["text"], output: ["embedding"] },
  decides: { input: ["text"], output: ["text"] },
};

function taskName(entry) {
  const t = entry?.task;
  if (!t) return "";
  const name = typeof t === "object" ? t.name : t;
  return String(name ?? "").toLowerCase().trim();
}

/**
 * Which slot an entry belongs in, or undefined when this plugin doesn't
 * serve it (a chat model, a classifier of images, a voice detector).
 */
export function slotOf(entry) {
  const task = taskName(entry);
  const name = String(entry?.name ?? entry?.id ?? "");
  const desc = String(entry?.description ?? "");

  switch (task) {
    case TASK.transcribe:
      return "transcription";
    case TASK.speech:
      return "speech";
    case TASK.draw:
      return "image";
    case TASK.embed:
      return "embedding";
    case TASK.describe:
      // Image-to-text: reads a picture and answers in words. The host files a
      // drawer or a transcriber, not a describer, so this is left out rather
      // than filed as something it isn't.
      return undefined;
    case TASK.gen:
      // The shared bucket: chat models, and clef. Only a decision model is
      // this plugin's; everything else chats, which is the CF plugin's job.
      return DECIDE_WORDS.test(name) ? "decides" : undefined;
    default:
      // An unfiled task (image classification, voice activity, translation…)
      // is not guessed at.
      if (!task && DECIDE_WORDS.test(name)) return "decides";
      return undefined;
  }
}

// clef's run endpoint wants the family name alone: a live call showed
// `POST /ai/run/@cf/cloudflare/clef` answering 200 with
// { result: { model: "clef", answers: {…} } }, while the full id there
// answers 7000 "No route for that URI". The last segment is what it takes.
export function bareID(id) {
  const parts = String(id).replace(/^@cf\//, "").split("/");
  return parts[parts.length - 1];
}

/**
 * Ask an account's own Workers AI list which models it serves.
 * @returns {Promise<Array<{id, name, slot, task}>>} sorted by slot then id
 */
export async function discoverModels({ accountId, apiKey, fetchImpl = fetch, signal } = {}) {
  if (!/^[0-9a-f]{32}$/i.test(String(accountId ?? ""))) {
    throw new Error("cf-media needs a 32-character hex Cloudflare Account ID");
  }
  const url = `${CF_API}/accounts/${accountId}/ai/models/search?per_page=200`;
  const resp = await fetchImpl(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body?.success === false) {
    const why = body?.errors?.[0]?.message ?? `HTTP ${resp.status}`;
    throw new Error(`Workers AI model search answered: ${why}`);
  }
  const entries = Array.isArray(body?.result) ? body.result : [];

  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = String(entry?.name ?? entry?.id ?? "").trim();
    if (!id.startsWith("@cf/") || seen.has(id)) continue;
    const slot = slotOf(entry);
    if (!slot) continue;
    seen.add(id);
    out.push({ id, name: id, slot, task: taskName(entry) || "unfiled" });
  }
  out.sort((a, b) => (a.slot === b.slot ? a.id.localeCompare(b.id) : a.slot.localeCompare(b.slot)));
  return out;
}

/** The config entry a discovered model gets. */
export function modelEntry(model) {
  const entry = {
    name: model.id,
    modalities: MODALITIES[model.slot],
    // Cloudflare bills these in Neurons off the day's free allocation; no
    // list price is claimed, so the host never reads one as cheap or dear.
  };
  if (model.slot === "image") {
    // Settings' image picker lists this when the id is an images-API model
    // and the plugin speaks @ai-sdk/openai-compatible.
    entry.attachment = false;
    entry.draws = true;
  }
  if (model.slot === "decides") {
    // Kept out of agents, offered as a group's classifier and as a
    // /v1/systemone answerer. The provider also needs `decide: true`.
    entry.decides = true;
    entry.decideModel = bareID(model.id);
  }
  return entry;
}

export { TASK, MODALITIES };