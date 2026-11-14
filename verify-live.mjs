// End-to-end checks against the live Cloudflare API, for the shapes this
// plugin has to get right. Nothing here is a mock: the account store is
// magpie's own, and every request goes to Workers AI.
//   node verify-live.mjs
import { CFMediaPlugin } from "./src/index.mjs"
import { cloudflareAccounts } from "./src/accounts.mjs"

// magpie's store, as this computer sees it. The plugin reads it the same
// way; MAGPIE_CONFIG_DIR is set here so the check works off the container.
process.env.MAGPIE_CONFIG_DIR = process.env.MAGPIE_CONFIG_DIR ?? "/tmp/mgfull"

const accounts = cloudflareAccounts()
console.log(`accounts read from magpie's store: ${accounts.length}`)
for (const a of accounts) console.log(`   ${a.label}  ${a.accountId}  …${a.key.slice(-6)}`)
if (!accounts.length) {
  console.error("no accounts: check MAGPIE_CONFIG_DIR / plugin-auth.json")
  process.exit(1)
}

const plugin = await CFMediaPlugin({}, {});
const cfg = { provider: {} }
await plugin.config(cfg)
console.log("\nconfig.provider['cf-media']:", JSON.stringify(cfg.provider["cf-media"], null, 2).slice(0, 500))

const models = await plugin.provider.models(undefined, {})
const ids = Object.keys(models)
console.log(`\nmodels listed for one provider: ${ids.length}`)
for (const id of ids) console.log("   ", id, "→", JSON.stringify(models[id].modalities))

const loader = await plugin.auth.loader(async () => undefined, {})
const call = (path, body, headers = {}) =>
  loader.fetch(new Request(`https://cf-media.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))

// --- image generation ---
console.log("\n[image] flux-1-schnell")
{
  const res = await call("/v1/images/generations", {
    model: "@cf/black-forest-labs/flux-1-schnell",
    prompt: "a red circle on white",
  })
  const body = await res.json().catch(() => ({}))
  const b64 = body?.data?.[0]?.b64_json
  console.log("   status:", res.status, "| b64 length:", typeof b64 === "string" ? b64.length : "missing")
}

// --- System One via clef ---
console.log("\n[systemone] clef")
{
  const res = await call("/v1/systemone", {
    model: "@cf/cloudflare/clef",
    state: { text: "the user asked for a summary of a long document" },
    questions: { hard: { type: "noul", instructions: "how hard is this turn" } },
  })
  const body = await res.json().catch(() => ({}))
  console.log("   status:", res.status, "| body:", JSON.stringify(body).slice(0, 300))
}

// --- embeddings ---
console.log("\n[embeddings] bge-m3")
{
  const res = await call("/v1/embeddings", { model: "@cf/baai/bge-m3", input: "hello world" })
  const body = await res.json().catch(() => ({}))
  console.log("   status:", res.status, "| dims:", body?.data?.[0]?.embedding?.length ?? "missing")
}