/* eslint-disable no-console */
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

async function waitForFile(filePath, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function run() {
  const resultsPath = path.join(process.cwd(), ".ws-results.json");
  try { await fsp.unlink(resultsPath); } catch {}

  // Ensure built
  console.log("[ws-test] Building project...");
  await new Promise((resolve, reject) => {
    const p = spawn("npm", ["run", "build"], { stdio: "inherit", shell: true });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("build failed"))));
  });

  // Start server
  console.log("[ws-test] Starting server on port 3010...");
  const server = spawn("npx", ["next", "start", "-p", "3010"], { stdio: "inherit", shell: true });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch {} };
  process.on("exit", stopServer);

  // Wait for server
  const ok = await waitForHttp("http://localhost:3010/", 30000);
  if (!ok) throw new Error("Server did not start in time");

  // Launch headless browser with Playwright
  console.log("[ws-test] Launching headless Chromium and running /ws-test...");
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("http://localhost:3010/ws-test", { waitUntil: "networkidle" });
  // Poll for window.__wsResults exposed by the page
  const data = await page.waitForFunction(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window; const r = w.__wsResults;
    return r && Array.isArray(r.results) ? r : null;
  }, null, { timeout: 180000 }).then(h => h.jsonValue());
  await browser.close();
  stopServer();

  // Summarize
  const baseline = data.baseline ?? 0;
  const improved = data.results.filter((r) => r.count > baseline);
  improved.sort((a, b) => b.count - a.count);

  console.log("\n[ws-test] Baseline (no watershed):", baseline);
  console.log("[ws-test] Improved configs (top 12):\n");
  for (const r of improved.slice(0, 12)) {
    const p = r.params;
    console.log(
      `count=${r.count} | mode=${p.mode}${p.mode === "alpha" ? `, alpha=${p.splitStrength}` : `, T=${p.dtThreshAbs}`} | dist=${p.distType}, mask=${p.distMask}, pk=${p.peakCleanupSize}`
    );
  }
  if (improved.length === 0) {
    console.log("[ws-test] No watershed settings improved over baseline.");
  }
}

run().catch((e) => {
  console.error("[ws-test] Error:", e);
  process.exit(1);
});


