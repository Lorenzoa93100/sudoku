// Tests de la page de sonde temporaire (lot 0) : node --test --test-concurrency=1 "dev/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeApi } from "./fake-api.mjs";
import { BACKEND_HOST, FRONT_HOST, startServers } from "./servers.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "sonde_" + "Abc_-123".repeat(5) + "xyz";
let servers, browser, fake;

before(async () => {
  servers = await startServers({ root: ROOT, fake: { handle: r => fake.handle(r) } });
  browser = await chromium.launch({
    args: [`--host-resolver-rules=${servers.hostRules}`],
    proxy: { server: process.env.HTTPS_PROXY || "http://127.0.0.1:9", bypass: `${FRONT_HOST},${BACKEND_HOST}` },
  });
});
after(async () => { await browser?.close(); await servers?.close(); });
beforeEach(() => { fake = createFakeApi(); fake.probeSecret = SECRET; });

async function openProbe() {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const urls = [];
  ctx.on("request", r => urls.push(r.url()));
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`${servers.url}sonde.html`);
  return { page, ctx, urls, errors };
}

test("CSP propre à la page : son seul script, l'API, aucun style ni unsafe", () => {
  const html = readFileSync(join(ROOT, "sonde.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.equal(csp, "default-src 'none'; script-src https://lorenzoa93100.github.io/sudoku/sonde.js; "
    + "connect-src https://jeu.taila17c77.ts.net; base-uri 'none'; form-action 'none'");
  assert.ok(!/<script>|<style|\son[a-z]+="|style="/.test(html));
  const js = readFileSync(join(ROOT, "sonde.js"), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "localStorage", "sessionStorage", "console.", "eval(", "location.hash", "history."]) {
    assert.ok(!js.includes(bad), bad);
  }
});

test("mesure un flux : ticks comptés, fin lue, aucune trace du secret", async () => {
  const { page, ctx, urls, errors } = await openProbe();
  await page.fill("#secret", SECRET);
  await page.click("#start");
  await page.waitForFunction(() => /Fin : closed/.test(document.getElementById("status").textContent));
  const status = await page.textContent("#status");
  assert.match(status, /Ticks reçus : 5 \(dernier n° 5\)/);
  assert.match(status, /Connexions ouvertes : 1 \(coupures : 0\)/);
  assert.equal(await page.inputValue("#secret"), "", "le champ est vidé après lecture");
  await page.click("#echo");
  await page.waitForFunction(() => /\(20 mesures\)/.test(document.getElementById("status").textContent));
  const page_text = await page.evaluate(() => document.body.textContent + location.href);
  assert.ok(!page_text.includes(SECRET), "secret affiché ou dans l'URL");
  assert.ok(urls.every(u => !u.includes(SECRET)), "secret dans une URL de requête");
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
  const auth = fake.log.filter(r => r.path.startsWith("/v1/probe/"));
  assert.ok(auth.length >= 21 && auth.every(r => r.origin === "https://lorenzoa93100.github.io"));
  await ctx.close();
});

test("secret refusé (sonde fermée) : arrêt propre, sans boucle de requêtes", async () => {
  fake.probeSecret = null;
  const { page, ctx } = await openProbe();
  await page.fill("#secret", SECRET);
  await page.click("#start");
  await page.waitForFunction(() => /Secret refusé/.test(document.getElementById("log").textContent));
  const n = fake.log.length;
  await page.waitForTimeout(2500);
  assert.equal(fake.log.length, n, "pas de nouvel essai après un 404");
  assert.equal(await page.isDisabled("#start"), false);
  await ctx.close();
});

test("secret mal formé : rien n'est envoyé", async () => {
  const { page, ctx } = await openProbe();
  await page.fill("#secret", "pas-un-secret");
  await page.click("#start");
  await page.waitForFunction(() => /mal formé/.test(document.getElementById("log").textContent));
  assert.equal(fake.log.length, 0);
  await ctx.close();
});
