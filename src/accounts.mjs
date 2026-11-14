// Reading Cloudflare accounts from magpie's own sign-in store, so the CF
// Workers AI plugin's five sign-ins are used here without being entered a
// second time (星仔's point: 「读取 cf 官方插件的 key 而不需要再录入一遍」).
//
// The store is `<config>/plugin-auth.json`, a map of
//   "<provider id>" | "<provider id>#<slot>": { type: "api", key, metadata }
// where one provider id's extra accounts carry a `#` suffix and the same
// metadata. It is an internal file, so everything here is defensive: any
// shape it doesn't recognise reads as no accounts, and the plugin falls back
// to its own sign-in rather than failing.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CF_ACCOUNT_PROVIDER = "cloudflare-workers-ai";

/** Where magpie keeps its config, as the host tells a plugin or as it is. */
function configDir(ctx) {
  const said = ctx?.location?.directory ?? process.env.MAGPIE_CONFIG_DIR ?? process.env.MAGPIE_HOME;
  if (said) return said;
  // The plugin host runs in magpie's own folder (provider-plugins.md: a
  // plugin's fetch runs in magpie's plugin host, cwd = magpie's folder).
  for (const p of [
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "magpie") : undefined,
    join(process.env.HOME ?? "", ".config", "magpie"),
  ]) {
    if (p && existsSync(join(p, "plugin-auth.json"))) return p;
  }
  return process.cwd();
}

function readStore(ctx) {
  const dir = configDir(ctx);
  for (const candidate of [join(dir, "plugin-auth.json"), join("/config/magpie", "plugin-auth.json")]) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // An unreadable store is no accounts, not a failed plugin.
    }
  }
  return {};
}

function usable(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    entry.type === "api" &&
    typeof entry.key === "string" &&
    entry.key.trim() &&
    /^[0-9a-f]{32}$/i.test(String(entry.metadata?.accountId ?? ""))
  );
}

/**
 * Every Cloudflare account magpie already holds, the CF plugin's sign-ins,
 * in the store's own order (the primary first, its `#` slots after).
 * @returns {Array<{id: string, key: string, accountId: string, label: string}>}
 */
export function cloudflareAccounts(ctx) {
  const store = readStore(ctx);
  const out = [];
  for (const [id, entry] of Object.entries(store)) {
    const base = id.split("#")[0];
    if (base !== CF_ACCOUNT_PROVIDER || !usable(entry)) continue;
    const accountId = String(entry.metadata.accountId).toLowerCase();
    if (out.some((a) => a.accountId === accountId)) continue; // one per account
    const slot = id.includes("#") ? id.split("#")[1] : "";
    out.push({
      id,
      key: entry.key,
      accountId,
      // The label magpie shows the account by, else the store's slot.
      label: String(entry.metadata?.name ?? entry.name ?? slot ?? "").trim() || accountId.slice(0, 6),
    });
  }
  return out;
}

export { CF_ACCOUNT_PROVIDER, configDir, readStore };