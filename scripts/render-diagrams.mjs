// Renders docs/diagrams/*.mmd to SVG with mermaid-cli, using the installed Chrome.
//   npm run diagrams
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = new URL("../docs/diagrams/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
  .find((p) => existsSync(p));
if (!chrome) throw new Error("Chrome not found; install it or edit the path list in scripts/render-diagrams.mjs");
const puppeteer = join(tmpdir(), "mmdc-puppeteer.json");
writeFileSync(puppeteer, JSON.stringify({ executablePath: chrome, args: ["--no-sandbox"] }));

for (const f of readdirSync(DIR).filter((f) => f.endsWith(".mmd"))) {
  const out = join(DIR, f.replace(/\.mmd$/, ".svg"));
  execFileSync("npx", ["-y", "@mermaid-js/mermaid-cli@10.9.1", "-i", join(DIR, f), "-o", out, "-c", join(DIR, "config.json"), "-p", puppeteer, "-b", "#151E2E"],
    { stdio: "inherit", shell: true, env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" } });
  console.log(`rendered ${out}`);
}
