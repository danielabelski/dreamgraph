import { readFile } from "node:fs/promises";
import { PluginManifestSchema } from "@dreamgraph/sdk";
const p = `${process.env.USERPROFILE}\\.dreamgraph\\ee9ce3b9-0313-4768-b5f1-24b9b3fffc4b\\plugins\\hello-events\\plugin.json`;
const raw = await readFile(p, "utf8");
const r = PluginManifestSchema.safeParse(JSON.parse(raw));
if (r.success) {
  console.log("OK", r.data.id, r.data.version, "tools:", r.data.tools.length, "policies:", r.data.policies.length, "fences:", r.data.markdownFences.length);
} else {
  console.log("FAIL", JSON.stringify(r.error.issues, null, 2));
}
