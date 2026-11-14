// Reads one account's live Workers AI list and prints where each model
// lands, so a rule change can be checked against what Cloudflare answers.
//   node verify-discovery.mjs [path to plugin-auth.json]
import { readFileSync } from "node:fs"
import { discoverModels } from "./src/discover.mjs"

const path = process.argv[2] ?? "/tmp/mgfull/plugin-auth-live.json"
const auth = JSON.parse(readFileSync(path, "utf8"))["cloudflare-workers-ai"]
if (!auth) throw new Error(`no cloudflare-workers-ai in ${path}`)

const models = await discoverModels({ accountId: auth.metadata.accountId, apiKey: auth.key })
const bySlot = {}
for (const m of models) (bySlot[m.slot] ??= []).push(m.id)

console.log("发现模型总数:", models.length)
for (const slot of ["transcription", "speech", "image", "embedding", "decides"]) {
  const ids = bySlot[slot] ?? []
  console.log(`\n[${slot}] ${ids.length}`)
  for (const id of ids) console.log("   ", id)
}
const unfiled = bySlot[undefined] ?? []
if (unfiled.length) console.log("\n[未归类]", unfiled.length)