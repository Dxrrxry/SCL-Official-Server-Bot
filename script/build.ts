import { build } from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

console.log("[build] Bundling bot...");

await build({
  entryPoints: [resolve(root, "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: resolve(root, "dist/index.cjs"),
  external: [
    // Native/optional modules that shouldn't be bundled
    "bufferutil",
    "utf-8-validate",
  ],
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

console.log("[build] Done → dist/index.cjs");
