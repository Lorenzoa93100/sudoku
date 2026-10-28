// Tests de bout en bout : node --test --test-concurrency=1 "dev/*.test.mjs"
// Chromium charge https://lorenzoa93100.github.io/sudoku/ et parle à https://jeu.taila17c77.ts.net,
// tous deux servis localement (dev/servers.mjs) : vraie CSP, vrai CORS, vrais pré-vols.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeApi, FRONT_ORIGIN, PUZZLE, SOLUTION } from "./fake-api.mjs";
import { BACKEND_HOST, FRONT_HOST, startServers } from "./servers.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED_HOSTS = new Set([FRONT_HOST, BACKEND_HOST]);
const TOKEN_KEY = "sudoku-tournoi-token";
// Grille fausse mais complète : deux cases à remplir de la 1re ligne permutées (indices 2 et 3).
const WRONG = SOLUTION.slice(0, 2) + SOLUTION[3] + SOLUTION[2] + SOLUTION.slice(4);

let servers, browser, fake;
const proxy = { handle: r => fake.handle(r) };

before(async () => {
  // Version d'avant le mode tournoi (un seul fichier, sans CSP) servie sous /orig/ pour comparer le solo.
  const orig = mkdtempSync(join(tmpdir(), "sudoku-orig-"));
  writeFileSync(join(orig, "index.html"), execFileSync("git", ["show", "c7959be:index.html"], { cwd: ROOT }));
  servers = await startServers({ root: ROOT, fake: proxy, extra: { "/orig/": orig } });
  browser = await chromium.launch({
    args: [`--host-resolver-rules=${servers.hostRules}`],
    // Le proxy du poste n'est pas utilisé pour les deux domaines simulés.
    proxy: { server: process.env.HTTPS_PROXY || "http://127.0.0.1:9", bypass: `${FRONT_HOST},${BACKEND_HOST}` },
  });
});
after(async () => { await browser?.close(); await servers?.close(); });
beforeEach(() => { fake = createFakeApi(); });

// Ouvre une page dans un contexte neuf (localStorage vide) et surveille ce qui ne doit pas arriver.
async function open(path = "", { brokenStorage = false, init } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "fr-FR", serviceWorkers: "block" });
  const watch = { csp: [], errors: [], hosts: new Set() };
  ctx.on("request", r => { const u = new URL(r.url()); if (u.protocol.startsWith("http")) watch.hosts.add(u.host); });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  if (brokenStorage) await ctx.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException("bloqué", "SecurityError"); };
  });
  if (init) await ctx.addInitScript(init);
  // L'ancienne version charge Google Fonts : on coupe, aucun accès réseau extérieur en test.
  await ctx.route(u => !ALLOWED_HOSTS.has(u.host), r => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", e => watch.errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") watch.errors.push(m.text()); });
  await page.goto(`${servers.url}${path}`);
  watch.check = async () => {
    assert.deepEqual(await page.evaluate(() => window.__csp), [], "violations de CSP");
    assert.deepEqual(watch.errors.filter(e => !/net::ERR_FAILED|Failed to load resource/.test(e)), [], "erreurs JS");
    for (const h of watch.hosts) assert.ok(ALLOWED_HOSTS.has(h), `requête vers un tiers : ${h}`);
  };
  return { page, ctx, watch };
}
const msg = page => page.locator("#tMsg");
async function register(page, { invite = fake.addInvite(), pseudo = "Alice", avatar = "dragon" } = {}) {
  await page.fill("#tInvite", invite);
  await page.fill("#tPseudo", pseudo);
  if (avatar) await page.click(`#tRegGallery [data-avatar="${avatar}"]`);
  await page.click("#tRegBtn");
}
async function loggedIn(path = "#tournoi", opts) {
  const { token } = fake.addUser("Alice", "dragon");
  return open(path, { ...opts, init: `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)})` });
}
async function fillGrid(page, grid) {
  for (let i = 0; i < 81; i++) {
    if (PUZZLE[i] !== "0") continue;
    await page.click(`#tBoard .cell >> nth=${i}`);
    await page.click(`#tPad .tnum >> nth=${Number(grid[i]) - 1}`);
  }
}

describe("sécurité statique du front", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  test("CSP stricte, sans unsafe-inline ni tiers, connect-src limité à l'API", () => {
    assert.ok(!csp.includes("unsafe"), csp);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src https:\/\/lorenzoa93100\.github\.io\/sudoku\/;/);
    assert.match(csp, /connect-src https:\/\/jeu\.taila17c77\.ts\.net;/);
    assert.ok(!/<script>|<style>|\son[a-z]+="|style="/.test(html), "aucun script, style ni gestionnaire en ligne");
  });
  test("le CSP est placé avant toute ressource", () => {
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<link"));
  });
  test("tournoi.js n'utilise jamais innerHTML ni d'API dangereuse", () => {
    const js = readFileSync(join(ROOT, "tournoi.js"), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      assert.ok(!js.includes(bad), bad);
    }
  });
  test("aucun secret ni jeton en dur", () => {
    for (const f of ["index.html", "app.js", "tournoi.js"]) {
      assert.ok(!/[A-Za-z0-9_-]{43}/.test(readFileSync(join(ROOT, f), "utf8").replace(/https?:\/\/\S+/g, "")), f);
    }
  });
});

describe("faux serveur : même CORS que Caddy", () => {
  test("seule l'origine GitHub Pages est servie", () => {
    const f = createFakeApi();
    const req = (o, method = "GET") => f.handle({ method, path: "/v1/me", headers: o ? { origin: o } : {}, body: "" });
    assert.equal(req(null).status, 404);
    assert.equal(req("https://evil.example").status, 404);
    assert.equal(req(FRONT_ORIGIN).status, 401);
    assert.equal(req(FRONT_ORIGIN).headers["access-control-allow-origin"], FRONT_ORIGIN);
    assert.equal(req(FRONT_ORIGIN, "DELETE").status, 404);
    const pre = o => f.handle({ method: "OPTIONS", path: "/v1/me", headers: { origin: o, "access-control-request-method": "GET" } });
    assert.equal(pre(FRONT_ORIGIN).status, 204);
    assert.equal(pre("https://evil.example").status, 404);
  });
});

describe("jeu solo inchangé", () => {
  test("se charge sans violation de CSP ni ressource tierce, polices locales", async () => {
    const { page, ctx, watch } = await open();
    await page.click('[data-new="facile"]');
    await page.waitForFunction(() => document.querySelectorAll("#board .cell.given").length >= 37);
    const faces = await page.evaluate(async () => (await Promise.all(["600 20px Fraunces", "700 20px Kalam", "500 20px Figtree"]
      .map(f => document.fonts.load(f)))).map(l => l.length && l.every(x => x.status === "loaded")));
    assert.deepEqual(faces, [true, true, true], "polices chargées depuis le dépôt");
    assert.ok([...watch.hosts].every(h => h === FRONT_HOST));
    await watch.check(); await ctx.close();
  });

  test("les codes de grille donnent exactement les mêmes grilles qu'avant", async () => {
    for (const code of ["F-23456AB", "M-ZZZZZZZ", "D-7KQ2MXP", "E-2B3C4D5"]) {
      const grids = [];
      for (const base of ["/orig/", "/sudoku/"]) {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        await ctx.route(u => !ALLOWED_HOSTS.has(u.host), r => r.abort());
        const page = await ctx.newPage();
        await page.goto(`https://${FRONT_HOST}${base}?g=${code}`);
        await page.waitForFunction(() => typeof G !== "undefined" && G && G.seed);
        grids.push(await page.evaluate(() => JSON.stringify([G.seed, G.puzzle, G.solution])));
        await ctx.close();
      }
      assert.equal(grids[1], grids[0], code);
    }
  });

  test("réglages, aides et fin de partie : rendu identique sans attribut style", async () => {
    const { page, ctx, watch } = await open();
    await page.click('[data-new="facile"]');
    await page.waitForFunction(() => typeof G !== "undefined" && G);
    // Aide niveau 2 : légende colorée par classes
    await page.click("#hintBtn");
    await page.click('[data-act="more"]');
    const legend = await page.$$eval(".hint .legend i", is => is.map(i => getComputedStyle(i).backgroundColor));
    assert.ok(legend.length >= 3 && legend.every(c => c !== "rgba(0, 0, 0, 0)"), String(legend));
    // Réglages : aperçus des thèmes et pastilles colorés par le DOM
    await page.click("#menuBtn"); await page.click('[data-act="settings"]');
    const prev = await page.$$eval(".swatch .prev", ps => ps.map(p => getComputedStyle(p).backgroundImage + getComputedStyle(p).backgroundColor));
    assert.equal(prev.length, 11);
    assert.ok(prev[0].includes("linear-gradient") && prev.slice(1).every(p => !p.endsWith("rgba(0, 0, 0, 0)")));
    const dots = await page.$$eval(".dotbtn:not(.custom):not(.theme)", ds => ds.map(d => getComputedStyle(d).backgroundColor));
    assert.ok(dots.length === 7 && new Set(dots).size === 7, String(dots));
    // Partie gagnée : feuille de fin avec image
    await page.evaluate(() => { for (let i = 0; i < 81; i++) if (!G.values[i]) { selected = i; input(G.solution[i]); } });
    await page.waitForSelector("#shareImg:not([hidden])");
    assert.equal(await page.$eval(".winactions", d => getComputedStyle(d).display), "flex");
    await watch.check(); await ctx.close();
  });
});

describe("mode tournoi", () => {
  test("accès depuis le menu du solo et retour", async () => {
    const { page, ctx, watch } = await open();
    await page.click('a[href="#tournoi"]');
    await page.waitForSelector("#vRegister:not([hidden])");
    assert.equal(await page.isHidden("#app"), true);
    await page.click("#tBack");
    await page.waitForSelector("#app:not([hidden])");
    await watch.check(); await ctx.close();
  });

  test("inscription : contrôles locaux, puis succès avec jeton stocké sous une clé dédiée", async () => {
    const { page, ctx, watch } = await open("#tournoi");
    await register(page, { pseudo: "é", avatar: null });
    await assert.doesNotReject(msg(page).getByText("Pseudo : 3 à 20").waitFor());
    await register(page, { avatar: null });
    await msg(page).getByText("Choisis un avatar").waitFor();
    assert.equal(fake.log.filter(r => r.method === "POST").length, 0, "rien n'est envoyé tant que le formulaire est invalide");
    await register(page, { invite: "x".repeat(32) });
    await msg(page).getByText("Code d'invitation invalide").waitFor();
    await register(page);
    await page.waitForSelector("#vLobby:not([hidden])");
    assert.equal(await page.textContent("#tProfName"), "Alice");
    assert.equal(await page.textContent("#tProfAv"), "🐉");
    const keys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("sudoku-tournoi")));
    assert.deepEqual(keys, [TOKEN_KEY]);
    assert.match(await page.evaluate(k => localStorage.getItem(k), TOKEN_KEY), /^[A-Za-z0-9_-]{43}$/);
    const reg = fake.log.find(r => r.path === "/v1/register" && r.method === "POST" && r.body.includes("Alice"));
    assert.deepEqual(Object.keys(JSON.parse(reg.body)).sort(), ["avatar", "invite_code", "pseudo"]);
    await watch.check(); await ctx.close();
  });

  test("422 avatar_required et 409 pseudo_taken : messages dédiés", async () => {
    const { page, ctx } = await open("#tournoi");
    fake.queue({ status: 422, body: { error: "avatar_required" } });
    await register(page);
    await msg(page).getByText("Choisis un avatar.").waitFor();
    fake.addUser("Alice");
    await register(page);
    await msg(page).getByText("Ce pseudo est déjà pris.").waitFor();
    await ctx.close();
  });

  test("localStorage indisponible : avertissement clair", async () => {
    const { page, ctx } = await open("#tournoi", { brokenStorage: true });
    await page.waitForSelector("#tStorageWarn:not([hidden])");
    await register(page);
    await page.waitForSelector("#vLobby:not([hidden])");
    await msg(page).getByText("ta session sera perdue").waitFor();
    await ctx.close();
  });

  test("manche complète : énoncé au start, seule la grille est envoyée, aucune case désignée", async () => {
    const rid = fake.addRound();
    const { page, ctx, watch } = await loggedIn();
    await page.click(`#tRounds button:has-text("Jouer")`);
    await page.waitForSelector("#vPlay:not([hidden])");
    const givens = await page.$$eval("#tBoard .cell.given", cs => cs.length);
    assert.equal(givens, [...PUZZLE].filter(c => c !== "0").length);
    assert.equal(await page.isVisible("#hintBtn"), false, "pas d'aides en tournoi");
    assert.equal(await page.locator("#tournoi").getByText("Aide", { exact: true }).count(), 0);
    assert.equal(await page.isDisabled("#tSubmit"), true);
    await fillGrid(page, WRONG);
    await page.click("#tSubmit");
    await page.locator("#tResult").getByText("Grille incorrecte. Essais restants : 4.").waitFor();
    assert.equal(await page.$$eval("#tBoard .wrong, #tBoard .errmark", e => e.length), 0);
    // Corrige les deux dernières cases
    await page.click("#tBoard .cell >> nth=2"); await page.keyboard.press(SOLUTION[2]);
    await page.click("#tBoard .cell >> nth=3"); await page.keyboard.press(SOLUTION[3]);
    await page.click("#tSubmit");
    await page.locator("#tResult").getByText("Grille correcte !").waitFor();
    for (const r of fake.log.filter(r => r.path === `/v1/rounds/${rid}/submit`)) {
      assert.deepEqual(Object.keys(JSON.parse(r.body)), ["grid"]);
    }
    assert.ok(fake.log.filter(r => r.method === "POST").every(r => !/time|elapsed|started/i.test(r.body)));
    await watch.check(); await ctx.close();
  });

  test("le chrono n'est qu'un affichage : aucune requête pendant la partie", async () => {
    fake.addRound();
    const { page, ctx } = await loggedIn();
    await page.click(`#tRounds button:has-text("Jouer")`);
    await page.waitForSelector("#vPlay:not([hidden])");
    const n = fake.log.length;
    await page.waitForTimeout(2500);
    assert.equal(fake.log.length, n);
    assert.match(await page.textContent("#tClock"), /^00:0[2-4]$/);
    await ctx.close();
  });

  test("classement : rang, avatar, pseudo, temps, victoires ; manche terminée signalée", async () => {
    const rid = fake.addRound({ startsIn: -7_200_000, duration: 3_600_000 });
    const b = fake.addUser("Bob", "licorne"), c = fake.addUser("Chloe", "tortue");
    fake.addSolved(rid, b.id, 83_400, { finishedAt: Date.now() - 4_000_000 });
    fake.addSolved(rid, c.id, 95_000, { finishedAt: Date.now() - 3_900_000 });
    const { page, ctx, watch } = await loggedIn();
    await page.click(`#tRounds button:has-text("Classement")`);
    await page.waitForSelector("#vBoard:not([hidden])");
    assert.equal(await page.textContent("#tBoardState"), "Manche terminée : classement définitif.");
    const rows = await page.$$eval("#tBoardRows tr", trs => trs.map(tr => [...tr.cells].map(td => td.textContent)));
    assert.deepEqual(rows, [["1", "🦄", "Bob", "1:23,4", "1"], ["2", "🐢", "Chloe", "1:35,0", "0"]]);
    await watch.check(); await ctx.close();
  });

  test("données hostiles du serveur affichées comme du texte", async () => {
    const rid = fake.addRound({ startsIn: -7_200_000, duration: 3_600_000 });
    const evil = fake.addUser('<img src=x onerror="window.__xss=1">', "<b>x</b>");
    fake.addSolved(rid, evil.id, 60_000);
    const { page, ctx } = await loggedIn();
    await page.click(`#tRounds button:has-text("Classement")`);
    await page.waitForSelector("#vBoard:not([hidden])");
    assert.equal(await page.$$eval("#tournoi img, #tournoi b b", e => e.length), 0);
    assert.equal(await page.textContent("#tBoardRows td.tp"), '<img src=x onerror="window.__xss=1">');
    assert.equal(await page.textContent("#tBoardRows td.tav"), "❔");
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await ctx.close();
  });

  test("changement d'avatar", async () => {
    const { page, ctx } = await loggedIn();
    await page.waitForSelector("#vLobby:not([hidden])");
    await page.click("#tAvBtn");
    await page.click('#tAvGallery [data-avatar="fusee"]');
    await page.waitForFunction(() => document.getElementById("tProfAv").textContent === "🚀");
    assert.deepEqual(JSON.parse(fake.log.find(r => r.path === "/v1/me/avatar").body), { avatar: "fusee" });
    await ctx.close();
  });

  test("401 : jeton effacé, retour à l'inscription", async () => {
    const { page, ctx } = await loggedIn();
    await page.waitForSelector("#vLobby:not([hidden])");
    fake.revokeTokens();
    await page.click("#tRefresh");
    await page.waitForSelector("#vRegister:not([hidden])");
    await msg(page).getByText("Ta session n'est plus valide").waitFor();
    assert.equal(await page.evaluate(k => localStorage.getItem(k), TOKEN_KEY), null);
    await ctx.close();
  });

  test("429 : message d'attente, boutons grisés, aucune nouvelle requête", async () => {
    const { page, ctx } = await loggedIn();
    await page.waitForSelector("#vLobby:not([hidden])");
    fake.queue({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "5" } });
    await page.click("#tRefresh");
    // Retry-After n'est pas exposé par le CORS de Caddy : attente par défaut de 30 s.
    await msg(page).getByText("Patiente 30 s").waitFor();
    const n = fake.log.length;
    assert.equal(await page.isDisabled("#tRefresh"), true);
    await page.click("#tAvBtn", { force: true }).catch(() => {});
    await page.waitForTimeout(1500);
    assert.equal(fake.log.length, n);
    await ctx.close();
  });

  test("panne réseau, erreur 500, réponse inattendue : messages génériques", async () => {
    const { page, ctx } = await loggedIn();
    await page.waitForSelector("#vLobby:not([hidden])");
    const cases = [
      [{ abort: true }, "Serveur injoignable."],
      [{ status: 500, body: { error: "internal_error" } }, "Le serveur rencontre un problème."],
      [{ status: 200, body: "<html>oops</html>", headers: { "content-type": "text/html" } }, "Réponse inattendue du serveur."],
      [{ status: 200, body: { pseudo: 42 } }, "Réponse inattendue du serveur."],
      [{ status: 404, body: { error: "not_found" } }, "Introuvable."],
      [{ status: 418, body: { error: "message libre du serveur" } }, "Une erreur est survenue."],
    ];
    for (const [r, text] of cases) {
      // Chromium relance une fois un GET dont la connexion est coupée : on coupe plusieurs fois.
      for (let k = 0; k < (r.abort ? 4 : 1); k++) fake.queue(r);
      await page.click("#tRefresh");
      await msg(page).getByText(text).waitFor();
      fake.clearQueue();
      assert.ok(!(await msg(page).textContent()).includes("message libre"));
    }
    await ctx.close();
  });

  test("refuse de s'afficher dans un cadre", async () => {
    const { page, ctx } = await loggedIn("");
    await page.goto(`https://${FRONT_HOST}/orig/`);  // page sans CSP qui encadre le jeu
    fake.log.length = 0;
    await page.evaluate(url => { const f = document.createElement("iframe"); f.src = url; document.body.append(f); }, `${servers.url}#tournoi`);
    const frame = await (await page.waitForSelector("iframe")).contentFrame();
    await frame.waitForSelector("#tMsg:not([hidden])");
    assert.match(await frame.textContent("#tMsg"), /ne s'ouvre pas dans un cadre/);
    assert.equal(await frame.isHidden("#vLobby"), true);
    assert.equal(fake.log.length, 0, "aucune requête avec le jeton depuis un cadre");
    await ctx.close();
  });

  test("le solo ne reçoit aucune touche en mode tournoi, puis reste en pause", async () => {
    const { page, ctx } = await open();
    await page.click('[data-new="facile"]');
    await page.waitForFunction(() => typeof G !== "undefined" && G);
    const before = await page.evaluate(() => JSON.stringify(G.values));
    await page.evaluate(() => { location.hash = "#tournoi"; });
    await page.waitForSelector("#vRegister:not([hidden])");
    for (const k of ["5", "h", " ", "Backspace", "n"]) await page.keyboard.press(k);
    assert.equal(await page.evaluate(() => JSON.stringify(G.values)), before);
    assert.equal(await page.evaluate(() => document.getElementById("hint").classList.contains("open")), false);
    await page.click("#tBack");
    assert.equal(await page.evaluate(() => paused), true);
    await ctx.close();
  });
});
