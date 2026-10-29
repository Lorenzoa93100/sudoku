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
  const watch = { csp: [], errors: [], hosts: new Set(), console: [] };
  // Seule exception aux deux domaines : la NAVIGATION vers la page d'autorisation de Discord
  // (jamais suivie : bloquée plus bas). Un fetch vers discord.com resterait une erreur.
  ctx.on("request", r => {
    const u = new URL(r.url());
    if (!u.protocol.startsWith("http")) return;
    if (u.host === "discord.com" && r.isNavigationRequest()) return;
    watch.hosts.add(u.host);
  });
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
  page.on("console", m => { watch.console.push(m.text()); if (m.type() === "error") watch.errors.push(m.text()); });
  await page.goto(`${servers.url}${path}`);
  watch.check = async () => {
    assert.deepEqual(await page.evaluate(() => window.__csp), [], "violations de CSP");
    assert.deepEqual(watch.errors.filter(e => !/net::ERR_FAILED|Failed to load resource/.test(e)), [], "erreurs JS");
    for (const h of watch.hosts) assert.ok(ALLOWED_HOSTS.has(h), `requête vers un tiers : ${h}`);
  };
  return { page, ctx, watch };
}
const msg = page => page.locator("#tMsg");
// « Se connecter avec Discord » : la navigation vers Discord est interceptée (jamais suivie),
// puis on revient sur le front, page rechargée, avec le fragment que renverrait l'API.
async function discordLogin(page, { discordId = "nouveau", error = null, tamper = null } = {}) {
  const nav = page.waitForRequest(r => new URL(r.url()).host === "discord.com");
  await page.click("#tLoginBtn");
  const url = new URL((await nav).url());
  let frag = fake.discordReturn(url.searchParams.get("state"), { discordId, error });
  if (tamper) frag = tamper(frag);
  await page.goto("about:blank");
  await page.goto(servers.url + frag);
  return { url, frag };
}
async function fillSignup(page, { pseudo = "Alice", avatar = "dragon" } = {}) {
  await page.fill("#tPseudo", pseudo);
  if (avatar) await page.click(`#tRegGallery [data-avatar="${avatar}"]`);
  await page.click("#tSignupBtn");
}
async function register(page, opts = {}) {
  await discordLogin(page, opts);
  await page.waitForSelector("#vSignup:not([hidden])");
  await fillSignup(page, opts);
}
async function loggedIn(path = "#tournoi", opts) {
  const { token } = fake.addUser("Alice", "dragon");
  return open(path, { ...opts, init: `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)})` });
}
// Depuis l'écran d'accueil : « Nouvelle partie », « Solo », puis une difficulté.
async function newGame(page, key = "facile") {
  await page.click('.menu.home button:has-text("Nouvelle partie")');
  await page.click('.menu.home button:has-text("Solo")');
  await page.click(`[data-new="${key}"]`);
  await page.waitForFunction(() => typeof G !== "undefined" && G && !document.getElementById("overlay").classList.contains("open"));
}
const homeButtons = page => page.$$eval(".menu.home > *", els => els.map(e => e.childNodes[0].textContent.trim()));
// Accueil → Nouvelle partie → Tournoi → Rejoindre : les écrans tournoi existants.
async function joinTournament(page) {
  await page.click('.menu.home button:has-text("Nouvelle partie")');
  await page.click('.menu.home button:has-text("Tournoi")');
  await page.click('.menu.home button:has-text("Rejoindre")');
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
    await newGame(page);
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
    await newGame(page);
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

describe("écran d'accueil", () => {
  // Partie valide enregistrée par le jeu lui-même, réutilisée pour fabriquer les cas corrompus.
  let savedGame;
  before(async () => {
    const { page, ctx } = await open();
    await newGame(page);
    await page.evaluate(() => { const i = G.puzzle.findIndex(x => !x); selected = i; input(G.solution[i]); G.time = 75; save(); });
    savedGame = JSON.parse(await page.evaluate(() => localStorage.getItem("sdk-game")));
    await ctx.close();
  });
  const withGame = value => `localStorage.setItem("sdk-game", ${JSON.stringify(typeof value === "string" ? value : JSON.stringify(value))})`;

  test("aucune partie : Nouvelle partie et Classement, sans Continuer ni Mode tournoi", async () => {
    const { page, ctx, watch } = await open();
    await page.waitForSelector(".menu.home");
    assert.deepEqual(await homeButtons(page), ["Nouvelle partie", "Classement"]);
    assert.equal(await page.$$eval('#sheet a[href="#tournoi"]', a => a.length), 0, "plus de lien tournoi sur l'accueil");
    assert.equal(await page.evaluate(() => document.getElementById("overlay").dataset.dismiss), "", "pas de fermeture sans choix");
    await page.click('.menu.home button:has-text("Nouvelle partie")');
    assert.deepEqual(await homeButtons(page), ["Solo", "Tournoi"]);
    await page.click('.menu.home button:has-text("Solo")');
    assert.equal(await page.$$eval("[data-new]", b => b.length), 5, "choix de difficulté actuel");
    await watch.check(); await ctx.close();
  });

  test("Nouvelle partie → Tournoi : Rejoindre et Créer mènent aux écrans tournoi (connexion d'abord)", async () => {
    const { page, ctx, watch } = await open();
    await page.click('.menu.home button:has-text("Nouvelle partie")');
    await page.click('.menu.home button:has-text("Tournoi")');
    assert.deepEqual(await homeButtons(page), ["Rejoindre", "Créer"]);
    assert.equal(await page.locator('.menu.home button:has-text("Créer")').isDisabled(), false);
    await page.click('.menu.home button:has-text("Créer")');
    await page.waitForSelector("#vLogin:not([hidden])");
    await msg(page).getByText("Connecte-toi pour continuer").waitFor();
    assert.equal(await page.evaluate(() => location.hash), "#tournoi");
    await watch.check(); await ctx.close();
  });

  test("boutons Retour : Tournoi → Nouvelle partie → Accueil", async () => {
    const { page, ctx } = await open("", { init: withGame(savedGame) });
    await page.click('.menu.home button:has-text("Nouvelle partie")');
    await page.click('.menu.home button:has-text("Tournoi")');
    await page.click(".homeback");
    assert.deepEqual(await homeButtons(page), ["Solo", "Tournoi"]);
    await page.click(".homeback");
    assert.deepEqual(await homeButtons(page), ["Nouvelle partie", "Continuer la partie", "Classement"]);
    assert.equal(await page.$$eval(".homeback", b => b.length), 0, "pas de Retour sur l'accueil");
    await ctx.close();
  });

  test("partie sauvegardée : Continuer reprend exactement la partie", async () => {
    const { page, ctx, watch } = await open("", { init: withGame(savedGame) });
    await page.waitForSelector(".menu.home");
    assert.deepEqual(await homeButtons(page), ["Nouvelle partie", "Continuer la partie", "Classement"]);
    assert.match(await page.textContent(".menu.home .homesub"), /^Facile · 01:15$/);
    await page.click('.menu.home button:has-text("Continuer la partie")');
    assert.equal(await page.evaluate(() => document.getElementById("overlay").classList.contains("open")), false);
    assert.equal(await page.evaluate(() => JSON.stringify(G.values)), JSON.stringify(savedGame.values));
    assert.equal(await page.evaluate(() => G.time), 75);
    await watch.check(); await ctx.close();
  });

  test("partie terminée : pas de Continuer", async () => {
    const { page, ctx } = await open("", { init: withGame({ ...savedGame, done: true }) });
    await page.waitForSelector(".menu.home");
    assert.deepEqual(await homeButtons(page), ["Nouvelle partie", "Classement"]);
    await ctx.close();
  });

  const corrupted = {
    "texte non JSON": { raw: "{oups" },
    "tableau": { raw: "[1,2,3]" },
    "null": { raw: "null" },
    "difficulté inconnue": { key: "__proto__" },
    "values trop court": { values: [1, 2] },
    "valeur hors limites": { values: Array(81).fill(12) },
    "valeur non entière": { values: Array(81).fill(1.5) },
    "chaîne au lieu de tableau": { puzzle: "530070000" },
    "indice modifié": { values: [0, ...Array(80).fill(0)] },
    "solution invalide": { solution: Array(81).fill(1) },
    "notes négatives": { notes: Array(81).fill(-1) },
    "temps en texte": { time: "75" },
    "code de grille forgé": { seed: "<img src=x onerror=alert(1)>" },
    "done non booléen": { done: "non" },
  };
  for (const [name, change] of Object.entries(corrupted)) {
    test(`données corrompues (${name}) : pas de Continuer, page intacte`, async () => {
      const value = change.raw ?? JSON.stringify({ ...savedGame, ...change });
      const { page, ctx, watch } = await open("", { init: `localStorage.setItem("sdk-game", ${JSON.stringify(value)})` });
      await page.waitForSelector(".menu.home");
      assert.deepEqual(await homeButtons(page), ["Nouvelle partie", "Classement"]);
      await newGame(page);
      await watch.check(); await ctx.close();
    });
  }

  test("localStorage indisponible : pas de Continuer, le jeu fonctionne", async () => {
    const { page, ctx, watch } = await open("", { init: () => {
      Object.defineProperty(window, "localStorage", { get() { throw new DOMException("bloqué", "SecurityError"); } });
    } });
    await page.waitForSelector(".menu.home");
    assert.deepEqual(await homeButtons(page), ["Nouvelle partie", "Classement"]);
    await newGame(page);
    await page.evaluate(() => { const i = G.puzzle.findIndex(x => !x); selected = i; input(G.solution[i]); });
    assert.ok(await page.evaluate(() => G.values.some((v, i) => v && !G.puzzle[i])));
    await watch.check(); await ctx.close();
  });

  test("?g=CODE avec une partie en cours : confirmation avant de la remplacer", async () => {
    const { page, ctx, watch } = await open("?g=M-ZZZZZZZ", { init: withGame(savedGame) });
    await page.waitForSelector('[data-act="playShared"]');
    assert.match(await page.textContent("#sheet"), /Ta partie en cours sera remplacée/);
    await page.click('[data-act="keepGame"]');
    assert.equal(await page.evaluate(() => G.seed), savedGame.seed);
    assert.equal(await page.evaluate(() => location.search), "", "le paramètre est retiré de l'adresse");
    await page.goto(`${servers.url}?g=M-ZZZZZZZ`);
    await page.click('[data-act="playShared"]');
    await page.waitForFunction(() => G && G.seed === "M-ZZZZZZZ");
    await watch.check(); await ctx.close();
  });

  test("?g=CODE sans partie : la grille démarre directement, sans accueil", async () => {
    const { page, ctx } = await open("?g=M-ZZZZZZZ");
    await page.waitForFunction(() => typeof G !== "undefined" && G && G.seed === "M-ZZZZZZZ");
    assert.equal(await page.$$eval(".menu.home", e => e.length), 0);
    await ctx.close();
  });

  test("lien direct #tournoi : pas d'écran d'accueil", async () => {
    const { page, ctx, watch } = await open("#tournoi", { init: withGame(savedGame) });
    await page.waitForSelector("#vLogin:not([hidden])");
    assert.equal(await page.evaluate(() => document.getElementById("overlay").classList.contains("open")), false);
    await watch.check(); await ctx.close();
  });

  test("partie en cours : Rejoindre un tournoi met le solo en pause, Retour le retrouve", async () => {
    const { page, ctx, watch } = await open("", { init: withGame(savedGame) });
    await joinTournament(page);
    await page.waitForSelector("#vLogin:not([hidden])");
    assert.equal(await page.evaluate(() => paused), true);
    await page.click("#tBack");
    await page.waitForSelector("#app:not([hidden])");
    assert.equal(await page.evaluate(() => JSON.stringify(G.values)), JSON.stringify(savedGame.values));
    await watch.check(); await ctx.close();
  });
});

describe("mode tournoi", () => {
  test("accès depuis l'accueil et retour à l'accueil", async () => {
    const { page, ctx, watch } = await open();
    await joinTournament(page);
    await page.waitForSelector("#vLogin:not([hidden])");
    assert.equal(await page.isHidden("#app"), true);
    await page.click("#tBack");
    await page.waitForSelector("#app:not([hidden])");
    assert.deepEqual(await homeButtons(page), ["Nouvelle partie", "Classement"], "sans partie solo : retour à l'accueil");
    await watch.check(); await ctx.close();
  });

  test("accès depuis le menu du solo", async () => {
    const { page, ctx, watch } = await open();
    await newGame(page);
    await page.click("#menuBtn");
    await page.click('#sheet a[href="#tournoi"]');
    await page.waitForSelector("#vLogin:not([hidden])");
    await watch.check(); await ctx.close();
  });

  test("connexion Discord : nonce envoyé, navigation vers Discord, retour effacé de l'adresse", async () => {
    const { page, ctx, watch } = await open("#tournoi");
    await page.waitForSelector("#vLogin:not([hidden])");
    const { url, frag } = await discordLogin(page);
    assert.equal(`${url.origin}${url.pathname}`, "https://discord.com/oauth2/authorize");
    assert.equal(url.searchParams.get("scope"), "identify");
    const start = fake.log.find(r => r.path === "/v1/auth/discord/start");
    assert.deepEqual(Object.keys(JSON.parse(start.body)), ["nonce"]);
    assert.match(JSON.parse(start.body).nonce, /^[A-Za-z0-9_-]{43}$/);
    await page.waitForSelector("#vSignup:not([hidden])");
    // Le code ne reste ni dans l'adresse ni dans l'historique (remplacé, pas ajouté).
    const code = new URLSearchParams(frag.slice(1)).get("login");
    assert.equal(await page.evaluate(() => location.hash), "#tournoi");
    assert.ok(!(await page.evaluate(() => location.href)).includes(code));
    assert.equal(await page.evaluate(() => sessionStorage.getItem("sudoku-tournoi-connexion")), null, "nonce consommé");
    const ex = fake.log.find(r => r.path === "/v1/auth/exchange");
    assert.deepEqual(Object.keys(JSON.parse(ex.body)).sort(), ["code", "nonce"]);
    assert.equal(JSON.parse(ex.body).nonce, JSON.parse(start.body).nonce);
    await watch.check();
    // L'entrée d'historique a été remplacée : revenir en arrière ne retrouve jamais le code.
    await page.goBack();
    assert.equal(page.url(), "about:blank");
    await ctx.close();
  });

  test("premier passage : contrôles locaux, puis compte créé, jeton sous une clé dédiée, jamais dans l'URL ni la console", async () => {
    const { page, ctx, watch } = await open("#tournoi");
    await discordLogin(page);
    await page.waitForSelector("#vSignup:not([hidden])");
    const posts = () => fake.log.filter(r => r.method === "POST").length;
    const n = posts();
    await fillSignup(page, { pseudo: "é", avatar: null });
    await msg(page).getByText("Pseudo : 3 à 20").waitFor();
    await fillSignup(page, { avatar: null });
    await msg(page).getByText("Choisis un avatar").waitFor();
    assert.equal(posts(), n, "rien n'est envoyé tant que le formulaire est invalide");
    await fillSignup(page);
    await page.waitForSelector("#vLobby:not([hidden])");
    assert.equal(await page.textContent("#tProfName"), "Alice");
    assert.equal(await page.textContent("#tProfAv"), "🐉");
    await msg(page).getByText("Bienvenue dans le tournoi").waitFor();
    const keys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("sudoku-tournoi")));
    assert.deepEqual(keys, [TOKEN_KEY]);
    const token = await page.evaluate(k => localStorage.getItem(k), TOKEN_KEY);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!(await page.evaluate(() => location.href)).includes(token));
    assert.ok(watch.console.every(t => !t.includes(token)), "jeton absent de la console");
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).length), 0, "rien en sessionStorage");
    const su = fake.log.find(r => r.path === "/v1/auth/signup");
    assert.deepEqual(Object.keys(JSON.parse(su.body)).sort(), ["avatar", "nonce", "pseudo", "ticket"]);
    await watch.check(); await ctx.close();
  });

  test("compte existant : retour direct aux manches", async () => {
    fake.addUser("Bob", "lion", { discordId: "bob-discord" });
    const { page, ctx, watch } = await open("#tournoi");
    await discordLogin(page, { discordId: "bob-discord" });
    await page.waitForSelector("#vLobby:not([hidden])");
    await msg(page).getByText("Content de te revoir, Bob").waitFor();
    assert.equal(fake.log.filter(r => r.path === "/v1/auth/signup").length, 0);
    await watch.check(); await ctx.close();
  });

  test("state différent (connexion lancée ailleurs) : ignorée, aucune requête", async () => {
    const { page, ctx, watch } = await open("#tournoi");
    await discordLogin(page, { tamper: f => f.replace(/state=[^&]+/, "state=" + "A".repeat(43)) });
    await page.waitForSelector("#vLogin:not([hidden])");
    await msg(page).getByText("n'a pas été lancée depuis cette page").waitFor();
    assert.equal(fake.log.filter(r => r.path === "/v1/auth/exchange").length, 0);
    assert.equal(await page.evaluate(() => location.hash), "#tournoi");
    await watch.check(); await ctx.close();
  });

  test("lien de retour forgé, sans connexion en cours : ignoré, effacé, aucune requête", async () => {
    const code = "C".repeat(43);
    const { page, ctx, watch } = await open(`#login=${code}&state=${"S".repeat(43)}`);
    await page.waitForSelector("#vLogin:not([hidden])");
    await msg(page).getByText("n'a pas été lancée depuis cette page").waitFor();
    assert.ok(!(await page.evaluate(() => location.href)).includes(code));
    assert.equal(fake.log.filter(r => r.path === "/v1/auth/exchange").length, 0);
    assert.equal(await page.$$eval(".menu.home", e => e.length), 0, "pas d'écran d'accueil par-dessus");
    await watch.check(); await ctx.close();
  });

  test("erreurs au retour : compte trop récent, refus, maintenance", async () => {
    const { page, ctx } = await open("#tournoi");
    for (const [error, text] of [["account_too_young", "au moins 30 jours"], ["denied", "Connexion refusée"],
                                 ["maintenance", "maintenance"], ["autre_chose", "Une erreur est survenue"]]) {
      await discordLogin(page, { error });
      await msg(page).getByText(text).waitFor();
      assert.equal(await page.evaluate(() => location.hash), "#tournoi");
    }
    assert.equal(fake.log.filter(r => r.path === "/v1/auth/exchange").length, 0);
    await ctx.close();
  });

  test("compte suspendu ou banni : raison et date, pas de session", async () => {
    fake.block("suspendu", { error: "account_suspended", reason: "cheating", until: Date.UTC(2030, 0, 15, 12) });
    fake.block("banni", { error: "account_banned", reason: "abuse" });
    const { page, ctx } = await open("#tournoi");
    await discordLogin(page, { discordId: "suspendu" });
    await msg(page).getByText(/suspendu jusqu'au .*15 janv.*raison : triche/).waitFor();
    await discordLogin(page, { discordId: "banni" });
    await msg(page).getByText(/banni \(raison : abus\)/).waitFor();
    assert.equal(await page.evaluate(k => localStorage.getItem(k), TOKEN_KEY), null);
    await ctx.close();
  });

  test("inscriptions fermées, pseudo refusé ou pris : messages dédiés", async () => {
    const { page, ctx } = await open("#tournoi");
    fake.signupsClosed = true;
    await discordLogin(page);
    await msg(page).getByText("inscriptions sont fermées").waitFor();
    fake.signupsClosed = false;
    await page.reload();  // 429 : pause imposée de 30 s dans la page
    await discordLogin(page);
    await page.waitForSelector("#vSignup:not([hidden])");
    await fillSignup(page, { pseudo: "Admin" });
    await msg(page).getByText("n'est pas accepté").waitFor();
    fake.addUser("Alice");
    await fillSignup(page, { pseudo: "alice" });
    await msg(page).getByText("déjà pris").waitFor();
    await fillSignup(page, { pseudo: "Alice2" });
    await page.waitForSelector("#vLobby:not([hidden])");
    await ctx.close();
  });

  test("URL de départ qui ne mène pas à Discord : refusée, pas de navigation", async () => {
    const { page, ctx } = await open("#tournoi");
    fake.queue({ status: 200, body: { url: "https://evil.example/oauth2/authorize?x=1" } });
    await page.click("#tLoginBtn");
    await msg(page).getByText("Réponse inattendue du serveur").waitFor();
    assert.equal(await page.evaluate(() => location.host), FRONT_HOST);
    await ctx.close();
  });

  test("sessionStorage bloqué : explication, aucune requête", async () => {
    const { page, ctx } = await open("#tournoi", { init: () => {
      Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("bloqué", "SecurityError"); } });
    } });
    await page.click("#tLoginBtn");
    await msg(page).getByText("bloque le stockage de session").waitFor();
    assert.equal(fake.log.length, 0);
    await ctx.close();
  });

  test("localStorage indisponible : avertissement clair", async () => {
    const { page, ctx } = await open("#tournoi", { init: () => {
      Object.defineProperty(window, "localStorage", { get() { throw new DOMException("bloqué", "SecurityError"); } });
    } });
    await page.waitForSelector("#tStorageWarn:not([hidden])");
    await register(page);
    await page.waitForSelector("#vLobby:not([hidden])");
    await msg(page).getByText("ta session sera perdue").waitFor();
    await ctx.close();
  });

  test("Mon compte : avertissements, déconnexion", async () => {
    const { token } = fake.addUser("Alice", "dragon", { warnings: [{ reason: "pseudo", created_at: Date.UTC(2030, 1, 3) }] });
    const { page, ctx, watch } = await open("#tournoi", { init: `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)})` });
    await page.click("#tAccountBtn");
    await page.waitForSelector("#vAccount:not([hidden])");
    assert.equal(await page.textContent("#tAccName"), "Alice");
    assert.match(await page.textContent("#tAccWarnList"), /3 février 2030 : pseudo inapproprié/);
    await page.click("#tLogout");
    await page.waitForSelector("#vLogin:not([hidden])");
    await msg(page).getByText("déconnecté sur cet appareil").waitFor();
    assert.equal(await page.evaluate(k => localStorage.getItem(k), TOKEN_KEY), null);
    assert.ok(fake.log.some(r => r.path === "/v1/auth/logout" && r.method === "POST"));
    await watch.check(); await ctx.close();
  });

  test("Se déconnecter de tous les appareils", async () => {
    const { page, ctx } = await loggedIn();
    await page.click("#tAccountBtn");
    await page.click("#tLogoutAll");
    await msg(page).getByText("tous tes appareils").waitFor();
    assert.ok(fake.log.some(r => r.path === "/v1/auth/logout-all"));
    assert.equal(await page.evaluate(k => localStorage.getItem(k), TOKEN_KEY), null);
    await ctx.close();
  });

  test("suppression du compte : pseudo à retaper, puis compte effacé", async () => {
    const { page, ctx, watch } = await loggedIn();
    await page.click("#tAccountBtn");
    await page.waitForSelector("#vAccount:not([hidden])");
    assert.equal(await page.isDisabled("#tDeleteBtn"), true);
    await page.fill("#tDeleteConfirm", "alice");
    assert.equal(await page.isDisabled("#tDeleteBtn"), true, "casse exacte exigée");
    await page.fill("#tDeleteConfirm", "Alice");
    await page.click("#tDeleteBtn");
    await page.waitForSelector("#vLogin:not([hidden])");
    await msg(page).getByText("Ton compte a été supprimé").waitFor();
    assert.deepEqual(JSON.parse(fake.log.find(r => r.path === "/v1/me/delete").body), { confirm_pseudo: "Alice" });
    assert.equal(await page.evaluate(k => localStorage.getItem(k), TOKEN_KEY), null);
    await watch.check(); await ctx.close();
  });

  test("classement : un compte supprimé s'affiche « Joueur supprimé »", async () => {
    const rid = fake.addRound();
    const gone = fake.addUser("Ancien", "lion");
    fake.addSolved(rid, gone.id, 50_000);
    fake.deleteUser(gone.id);
    const { page, ctx, watch } = await loggedIn();
    await page.click(`#tRounds button:has-text("Classement")`);
    await page.waitForSelector("#vBoard:not([hidden])");
    const row = await page.$$eval("#tBoardRows tr td", tds => tds.map(t => t.textContent));
    assert.deepEqual(row.slice(0, 3), ["1", "👤", "Joueur supprimé"]);
    await watch.check(); await ctx.close();
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

  test("401 : jeton effacé, retour à la connexion", async () => {
    const { page, ctx } = await loggedIn();
    await page.waitForSelector("#vLobby:not([hidden])");
    fake.revokeTokens();
    await page.click("#tRefresh");
    await page.waitForSelector("#vLogin:not([hidden])");
    await msg(page).getByText("Ta session a expiré. Reconnecte-toi avec Discord.").waitFor();
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
    await newGame(page);
    await page.waitForFunction(() => typeof G !== "undefined" && G);
    const before = await page.evaluate(() => JSON.stringify(G.values));
    await page.evaluate(() => { location.hash = "#tournoi"; });
    await page.waitForSelector("#vLogin:not([hidden])");
    for (const k of ["5", "h", " ", "Backspace", "n"]) await page.keyboard.press(k);
    assert.equal(await page.evaluate(() => JSON.stringify(G.values)), before);
    assert.equal(await page.evaluate(() => document.getElementById("hint").classList.contains("open")), false);
    await page.click("#tBack");
    assert.equal(await page.evaluate(() => paused), true);
    await ctx.close();
  });
});

describe("tournois créés par les joueurs", () => {
  const as = (user, path = "#tournoi") =>
    open(path, { init: `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(user.token)})` });
  const roomPlayers = page => page.$$eval("#tRoomPlayers li .tp", l => l.map(e => e.childNodes[0].textContent));

  test("créer, partager, rejoindre par lien, départ commun, partie, résultats", async () => {
    fake.countdownMs = 1500;
    const alice = fake.addUser("Alice", "dragon"), bob = fake.addUser("Bob", "lion");
    const A = await as(alice), B = { ...(await as(bob, "")) };
    A.page.on("dialog", d => d.accept());
    await A.page.click("#tGoCreate");
    await A.page.click('#tCreateDiff [data-diff="moyen"]');
    await A.page.selectOption("#tCreatePlayers", "3");
    await A.page.click("#tCreateBtn");
    await A.page.waitForSelector("#vRoom:not([hidden])");
    const create = fake.log.find(r => r.path === "/v1/tournaments" && r.method === "POST");
    assert.deepEqual(JSON.parse(create.body), { difficulty: "moyen", max_players: 3 });
    const code = await A.page.textContent("#tRoomCode");
    assert.match(code, /^[A-HJKMNP-Z2-9]{10}$/);
    assert.equal(await A.page.isDisabled("#tRoomStart"), true, "1 seul joueur");
    assert.match(await A.page.textContent("#tRoomWarn"), /5 minutes .* écran verrouillé/);
    // Bob arrive par le lien partagé : le code disparaît aussitôt de l'adresse.
    await B.page.goto(`${servers.url}#t=${code}`);
    await B.page.waitForSelector("#vRoom:not([hidden])");
    assert.equal(await B.page.evaluate(() => location.hash), "#tournoi");
    assert.deepEqual(JSON.parse(fake.log.find(r => r.path === "/v1/tournaments/join").body), { code });
    assert.equal(await B.page.isHidden("#tRoomStart"), true, "seul le créateur lance");
    // La salle d'Alice se met à jour seule.
    await A.page.waitForFunction(() => document.querySelectorAll("#tRoomPlayers li").length === 2, null, { timeout: 6000 });
    assert.deepEqual(await roomPlayers(A.page), ["Alice", "Bob"]);
    await A.page.click("#tRoomStart");
    await A.page.locator("#tRoomState").getByText("Départ dans").waitFor();
    // Même départ pour les deux, puis passage automatique à la grille.
    for (const X of [A, B]) await X.page.waitForSelector("#vPlay:not([hidden])", { timeout: 8000 });
    assert.equal(await A.page.isVisible("#tPlayWarn"), true);
    await fillGrid(B.page, SOLUTION);
    await B.page.click("#tSubmit");
    await B.page.locator("#tResult").getByText("Grille correcte").waitFor();
    // Alice abandonne (confirmation) : un seul résolu, pas de vainqueur.
    await A.page.click("#tAbandon");
    await A.page.waitForSelector("#vRoom:not([hidden])");
    await A.page.locator("#tRoomState").getByText("Pas de vainqueur").waitFor();
    const statuses = await A.page.$$eval("#tRoomPlayers li > .tst", l => l.map(e => e.textContent));
    assert.equal(statuses.length, 2);
    assert.match(statuses[0], /^1ᵉ · 0:0\d,\d$/);  // Bob, temps mesuré depuis le départ commun
    assert.equal(statuses[1], "abandon");
    for (const X of [A, B]) { await X.watch.check(); await X.ctx.close(); }
  });

  test("rejoindre : code mal formé (aucune requête), code inconnu, tournoi complet", async () => {
    const owner = fake.addUser("Owner"), other = fake.addUser("Other");
    const { page, ctx, watch } = await loggedIn();
    await page.click("#tGoJoin");
    await page.fill("#tJoinCode", "ABC");
    await page.click("#tJoinBtn");
    await msg(page).getByText("Le code fait 10 caractères").waitFor();
    assert.equal(fake.log.filter(r => r.path === "/v1/tournaments/join").length, 0);
    await page.fill("#tJoinCode", "zzzz-zzzz-zz");
    await page.click("#tJoinBtn");
    await msg(page).getByText("Code inconnu").waitFor();
    assert.deepEqual(JSON.parse(fake.log.find(r => r.path === "/v1/tournaments/join").body), { code: "ZZZZZZZZZZ" });
    const t = await (async () => {
      const r = fake.handle({ method: "POST", path: "/v1/tournaments", headers: { origin: FRONT_ORIGIN, authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
                             body: JSON.stringify({ difficulty: "facile", max_players: 2 }) });
      return JSON.parse(r.body);
    })();
    fake.joinTournament(t.id, other.id);
    await page.fill("#tJoinCode", t.code);
    await page.click("#tJoinBtn");
    await msg(page).getByText("Ce tournoi est complet").waitFor();
    await watch.check(); await ctx.close();
  });

  test("salle : un joueur la quitte, le créateur la ferme", async () => {
    const alice = fake.addUser("Alice"), bob = fake.addUser("Bob");
    const A = await as(alice), B = await as(bob);
    A.page.on("dialog", d => d.accept());
    await A.page.click("#tGoCreate"); await A.page.click("#tCreateBtn");
    await A.page.waitForSelector("#vRoom:not([hidden])");
    const code = await A.page.textContent("#tRoomCode");
    await B.page.click("#tGoJoin"); await B.page.fill("#tJoinCode", code); await B.page.click("#tJoinBtn");
    await B.page.waitForSelector("#vRoom:not([hidden])");
    assert.equal(await B.page.textContent("#tRoomLeave"), "Quitter la salle");
    await B.page.click("#tRoomLeave");
    await B.page.waitForSelector("#vLobby:not([hidden])");
    await msg(B.page).getByText("Tu as quitté la salle").waitFor();
    assert.equal(await A.page.textContent("#tRoomLeave"), "Fermer la salle");
    await A.page.click("#tRoomLeave");
    await msg(A.page).getByText("Salle fermée").waitFor();
    await A.ctx.close(); await B.ctx.close();
  });

  test("rafraîchissement suspendu quand la page est cachée, relancé à son retour", async () => {
    const { page, ctx } = await loggedIn();
    await page.click("#tGoCreate"); await page.click("#tCreateBtn");
    await page.waitForSelector("#vRoom:not([hidden])");
    const polls = () => fake.log.filter(r => r.method === "GET" && /^\/v1\/tournaments\/\d+$/.test(r.path)).length;
    await page.waitForFunction(() => true);
    await page.waitForTimeout(3500);
    assert.ok(polls() >= 1, "rafraîchi toutes les 3 s");
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
    const n = polls();
    await page.waitForTimeout(4000);
    assert.equal(polls(), n, "aucune requête page cachée");
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForFunction(() => true);
    await page.waitForTimeout(500);
    assert.equal(polls(), n + 1, "requête immédiate au retour");
    await ctx.close();
  });

  test("classement global : depuis l'accueil et le menu ☰, ma position", async () => {
    const alice = fake.addUser("Alice", "dragon");
    fake.leaderboard = uid => ({ players: 12, me: { rank: uid === alice.id ? 12 : null, wins: 1 },
      entries: [{ rank: 1, pseudo: "Zoé", avatar: "lion", wins: 9, deleted: false, me: false },
                { rank: 2, pseudo: null, avatar: null, wins: 7, deleted: true, me: false }] });
    const { page, ctx, watch } = await as(alice, "");
    await page.click('.menu.home button:has-text("Classement")');
    await page.waitForSelector("#vRanking:not([hidden])");
    const rows = await page.$$eval("#tRankRows tr", trs => trs.map(tr => [...tr.children].map(td => td.textContent)));
    assert.deepEqual(rows, [["1", "🦁", "Zoé", "9"], ["2", "👤", "Joueur supprimé", "7"]]);
    assert.match(await page.textContent("#tRankMe"), /12ᵉ sur 12 \(1 victoire\)/);
    await page.click("#tBack");
    await page.waitForSelector("#app:not([hidden])");
    await page.click('.menu.home button:has-text("Nouvelle partie")');
    await page.click('.menu.home button:has-text("Solo")');
    await page.click('[data-new="facile"]');
    await page.click("#menuBtn");
    await page.click('#sheet a[href="#tournoi-classement"]');
    await page.waitForSelector("#vRanking:not([hidden])");
    await watch.check(); await ctx.close();
  });

  test("classement sans être connecté : connexion d'abord, puis le classement", async () => {
    fake.leaderboard = () => ({ players: 0, me: { rank: null, wins: 0 }, entries: [] });
    const { page, ctx } = await open("#tournoi-classement");
    await page.waitForSelector("#vLogin:not([hidden])");
    assert.equal(fake.log.filter(r => r.path === "/v1/leaderboard").length, 0);
    await register(page);
    await page.waitForSelector("#vRanking:not([hidden])");
    await page.locator("#tRankMe").getByText("pas encore de victoire").waitFor();
    await ctx.close();
  });

  test("lien #t=CODE sans être connecté : connexion Discord puis arrivée dans la salle", async () => {
    const owner = fake.addUser("Owner");
    const r = fake.handle({ method: "POST", path: "/v1/tournaments", headers: { origin: FRONT_ORIGIN, authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
                           body: JSON.stringify({ difficulty: "facile", max_players: 4 }) });
    const { code } = JSON.parse(r.body);
    const { page, ctx, watch } = await open(`#t=${code}`);
    await page.waitForSelector("#vLogin:not([hidden])");
    assert.equal(await page.evaluate(() => location.hash), "#tournoi");
    await register(page, { pseudo: "Nouveau" });
    await page.waitForSelector("#vRoom:not([hidden])");
    assert.deepEqual(await roomPlayers(page), ["Owner", "Nouveau"]);
    await watch.check(); await ctx.close();
  });

  test("salon : mes tournois listés, réouverture de la salle", async () => {
    const alice = fake.addUser("Alice");
    const { page, ctx } = await as(alice);
    await page.click("#tGoCreate"); await page.click("#tCreateBtn");
    await page.waitForSelector("#vRoom:not([hidden])");
    await page.click("#tRoomBack");
    await page.waitForSelector("#vLobby:not([hidden])");
    assert.match(await page.textContent("#tTournaments"), /Renard rusé · Facile.*Salle d'attente.*1\/4 joueurs/);
    await page.click('#tTournaments button:has-text("Ouvrir")');
    await page.waitForSelector("#vRoom:not([hidden])");
    await ctx.close();
  });
});

