// Faux serveur d'API, pour développer et tester le mode tournoi sans toucher au vrai.
// Il reproduit le comportement visible de la prod : CORS de Caddy (une seule origine, 404
// uniforme ailleurs, pré-vol OPTIONS, corps limité à 4 Ko, Retry-After non exposé) et
// règles de l'API (connexion Discord avec nonce et empreinte, sessions, suppression de compte,
// avatars, un seul essai, validation par les règles, classement et victoires). Discord lui-même
// est simulé par `discordReturn` : les tests ne quittent jamais les deux domaines simulés. Il ne sert jamais en production : rien ici n'est publié.

export const FRONT_ORIGIN = "https://lorenzoa93100.github.io";
export const AVATARS = ["chat", "chien", "renard", "panda", "koala", "tigre", "lion", "grenouille", "hibou",
  "pingouin", "pieuvre", "baleine", "tortue", "abeille", "papillon", "licorne", "dragon", "fusee", "etoile", "cactus"];
export const PUZZLE = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
export const SOLUTION = "534678912672195348198342567859761423426853791713924856961537284287419635345286179";

import { createHash } from "node:crypto";

const RE_PSEUDO = /^[A-Za-z0-9_-]{3,20}$/, RE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const fingerprint = nonce => createHash("sha256").update(nonce).digest("base64url");
const UNITS = (() => {
  const u = [];
  for (let r = 0; r < 9; r++) u.push([...Array(9)].map((_, c) => r * 9 + c));
  for (let c = 0; c < 9; c++) u.push([...Array(9)].map((_, r) => r * 9 + c));
  for (let b = 0; b < 9; b++) u.push([...Array(9)].map((_, k) => (((b / 3) | 0) * 3 + ((k / 3) | 0)) * 9 + (b % 3) * 3 + (k % 3)));
  return u;
})();
export function isValidCompletion(puzzle, grid) {
  if (grid.length !== 81 || [...puzzle].some((p, i) => p !== "0" && p !== grid[i])) return false;
  return UNITS.every(u => new Set(u.map(i => grid[i])).size === 9 && u.every(i => grid[i] >= "1" && grid[i] <= "9"));
}
const randomToken = n => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return [...crypto.getRandomValues(new Uint8Array(n))].map(x => abc[x % 64]).join("");
};

export function createFakeApi({ clock = () => Date.now(), maxWrong = 5 } = {}) {
  const states = new Map();         // state -> nonce (départ vers Discord)
  const codes = new Map();          // code d'échange ou ticket -> { kind, discordId, nonce }
  const users = new Map();          // id -> { pseudo, avatar, discordId, created_at, warnings, deleted }
  const blocked = new Map();        // discordId -> { error, reason, until? }
  const tokens = new Map();         // token -> userId
  const rounds = new Map();         // id -> { id, difficulty, puzzle, starts_at, ends_at, min_solve_ms }
  const attempts = new Map();       // `${round}:${user}` -> attempt
  const queued = [];                // réponses forcées pour les prochaines requêtes /v1 (tests)
  const log = [];                   // requêtes reçues : { method, path, origin, body }
  let nextUser = 1, nextRound = 1, nextAttempt = 1;

  const fake = {
    log,
    // Sonde du lot 0 : secret attendu (null = sonde fermée) et nombre de ticks d'un flux.
    probeSecret: null,
    probeTicks: 5,
    addUser(pseudo, avatar = "chat", { discordId = `d${nextUser}`, warnings = [] } = {}) {
      const id = nextUser++;
      users.set(id, { pseudo, avatar, discordId, created_at: clock() - 86_400_000, warnings, deleted: false });
      const t = randomToken(43); tokens.set(t, id); return { id, token: t };
    },
    // Ce que ferait Discord puis l'API au retour : fragment à coller après l'URL du front.
    // error : refus côté Discord ; sinon un code d'échange lié au nonce du départ.
    discordReturn(state, { discordId = "nouveau", error = null } = {}) {
      const nonce = states.get(state);
      if (nonce === undefined) return "#login_error=expired";
      states.delete(state);
      if (error) return `#login_error=${error}&state=${fingerprint(nonce)}`;
      const code = randomToken(43); codes.set(code, { kind: "login", discordId, nonce });
      return `#login=${code}&state=${fingerprint(nonce)}`;
    },
    block(discordId, info) { blocked.set(discordId, info); },
    deleteUser(id) { const u = users.get(id); Object.assign(u, { pseudo: null, avatar: null, discordId: null, deleted: true }); },
    revokeTokens() { tokens.clear(); },
    addRound({ difficulty = "facile", puzzle = PUZZLE, startsIn = -60_000, duration = 3_600_000, minSolveMs = 0 } = {}) {
      const id = nextRound++, now = clock();
      rounds.set(id, { id, difficulty, puzzle, starts_at: now + startsIn, ends_at: now + startsIn + duration, min_solve_ms: minSolveMs });
      return id;
    },
    // Essai déjà joué (pour remplir un classement) : elapsed en ms, soumis à `finishedAt`.
    addSolved(roundId, userId, elapsed, { finishedAt = clock(), flagged = false } = {}) {
      attempts.set(`${roundId}:${userId}`, { id: nextAttempt++, round: roundId, user: userId, status: "solved",
        started_at: finishedAt - elapsed, finished_at: finishedAt, elapsed_ms: elapsed, wrong: 0, flagged });
    },
    endRound(id) { rounds.get(id).ends_at = clock() - 1; },
    // Prochaine réponse forcée : { status, body, headers } ou { abort: true } (panne réseau).
    queue(r) { queued.push(r); },
    clearQueue() { queued.length = 0; },
    handle,
  };

  function json(status, body, extra = {}) {
    return { status, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) };
  }
  const notFound = () => json(404, { error: "not_found" });

  // Requête HTTP simplifiée : { method, path, headers (minuscules), body (chaîne) }.
  function handle(req) {
    const origin = req.headers.origin;
    log.push({ method: req.method, path: req.path, origin, body: req.body || "" });
    // --- Comportement de Caddy ---
    if (req.method === "OPTIONS") {
      if (req.path.startsWith("/v1/") && origin === FRONT_ORIGIN && req.headers["access-control-request-method"]) {
        return { status: 204, headers: { "access-control-allow-origin": FRONT_ORIGIN, "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "Authorization, Content-Type", "access-control-max-age": "600", vary: "Origin" }, body: "" };
      }
      return notFound();
    }
    if (!["GET", "POST"].includes(req.method) || !req.path.startsWith("/v1/") || origin !== FRONT_ORIGIN) return notFound();
    const cors = { "access-control-allow-origin": FRONT_ORIGIN, vary: "Origin", "cache-control": "no-store" };
    const out = r => ({ ...r, headers: { ...r.headers, ...cors } });
    if ((req.body || "").length > 4096) return out(json(413, { error: "payload_too_large" }));
    const forced = queued.shift();
    if (forced) {
      if (forced.abort) return { abort: true };
      return out({ status: forced.status, headers: { "content-type": "application/json", ...(forced.headers || {}) },
        body: typeof forced.body === "string" ? forced.body : JSON.stringify(forced.body) });
    }
    return out(api(req));
  }

  // --- Comportement de l'API ---
  function api(req) {
    let body = null;
    if (req.body) {
      if ((req.headers["content-type"] || "").split(";")[0].trim() !== "application/json") return json(415, { error: "unsupported_media_type" });
      try { body = JSON.parse(req.body); } catch (e) { return json(422, { error: "invalid_request" }); }
    }
    const strict = (keys, required) => body && typeof body === "object" && !Array.isArray(body)
      && Object.keys(body).every(k => keys.includes(k)) && required.every(k => k in body);
    const route = `${req.method} ${req.path.replace(/\/\d+\//, "/:id/")}`;
    const rid = Number((/^\/v1\/rounds\/(\d+)\//.exec(req.path) || [])[1]);

    const secret = v => typeof v === "string" && RE_TOKEN.test(v);
    if (route === "POST /v1/auth/discord/start") {
      if (!strict(["nonce"], ["nonce"]) || !secret(body.nonce)) return json(422, { error: "invalid_request" });
      const state = randomToken(43); states.set(state, body.nonce);
      const q = new URLSearchParams({ response_type: "code", client_id: "123456789012345678", scope: "identify",
        state, redirect_uri: "https://jeu.taila17c77.ts.net/v1/auth/discord/callback", prompt: "none" });
      return json(200, { url: `${DISCORD_AUTHORIZE}?${q}` });
    }
    if (route === "POST /v1/auth/exchange") {
      if (!strict(["code", "nonce"], ["code", "nonce"]) || !secret(body.code) || !secret(body.nonce)) return json(422, { error: "invalid_request" });
      const c = codes.get(body.code);
      if (!c || c.kind !== "login" || c.nonce !== body.nonce) return json(401, { error: "invalid_code" });
      codes.delete(body.code);
      const b = blocked.get(c.discordId);
      if (b) return json(403, b.error === "account_suspended" ? { error: b.error, reason: b.reason, until: b.until } : { error: b.error, reason: b.reason });
      const found = [...users.entries()].find(([, u]) => u.discordId === c.discordId && !u.deleted);
      if (found) {
        const t = randomToken(43); tokens.set(t, found[0]);
        return json(200, { token: t, pseudo: found[1].pseudo, avatar: found[1].avatar });
      }
      if (fake.signupsClosed) return json(429, { error: "signups_closed" });
      const ticket = randomToken(43); codes.set(ticket, { kind: "signup", discordId: c.discordId, nonce: body.nonce });
      return json(200, { signup: ticket });
    }
    if (route === "POST /v1/auth/signup") {
      if (!strict(["ticket", "nonce", "pseudo", "avatar"], ["ticket", "nonce", "pseudo", "avatar"]) || !secret(body.ticket) || !secret(body.nonce)
        || typeof body.pseudo !== "string" || !RE_PSEUDO.test(body.pseudo) || !AVATARS.includes(body.avatar)) return json(422, { error: "invalid_request" });
      const c = codes.get(body.ticket);
      if (!c || c.kind !== "signup" || c.nonce !== body.nonce) return json(401, { error: "invalid_ticket" });
      if (/admin|connard/i.test(body.pseudo)) return json(422, { error: "pseudo_forbidden" });
      if ([...users.values()].some(u => u.pseudo && u.pseudo.toLowerCase() === body.pseudo.toLowerCase())) return json(409, { error: "pseudo_taken" });
      codes.delete(body.ticket);
      const uid = nextUser++;
      users.set(uid, { pseudo: body.pseudo, avatar: body.avatar, discordId: c.discordId, created_at: clock(), warnings: [], deleted: false });
      const t = randomToken(43); tokens.set(t, uid);
      return json(201, { token: t, pseudo: body.pseudo, avatar: body.avatar });
    }
    if (req.path.startsWith("/v1/probe/")) return probe(req, route, body);
    const [scheme, t] = (req.headers.authorization || "").split(" ");
    const uid = scheme === "Bearer" && RE_TOKEN.test(t || "") ? tokens.get(t) : undefined;
    if (!uid || users.get(uid).deleted) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    const user = users.get(uid), now = clock();

    if (route === "GET /v1/me") return json(200, { pseudo: user.pseudo, avatar: user.avatar, created_at: user.created_at,
      wins: wins(now).get(uid) || 0, warnings: user.warnings });
    if (route === "POST /v1/auth/logout") { tokens.delete(t); return json(200, { ok: true }); }
    if (route === "POST /v1/auth/logout-all") { for (const [k, v] of tokens) if (v === uid) tokens.delete(k); return json(200, { ok: true }); }
    if (route === "POST /v1/me/delete") {
      if (!strict(["confirm_pseudo"], ["confirm_pseudo"]) || typeof body.confirm_pseudo !== "string") return json(422, { error: "invalid_request" });
      if (body.confirm_pseudo !== user.pseudo) return json(422, { error: "confirmation_mismatch" });
      fake.deleteUser(uid);
      for (const [k, v] of tokens) if (v === uid) tokens.delete(k);
      return json(200, { deleted: true });
    }
    if (route === "POST /v1/me/avatar") {
      if (!strict(["avatar"], ["avatar"]) || !AVATARS.includes(body.avatar)) return json(422, { error: "invalid_request" });
      user.avatar = body.avatar; return json(200, { avatar: body.avatar });
    }
    if (route === "GET /v1/rounds") {
      const list = [...rounds.values()].sort((a, b) => b.starts_at - a.starts_at).map(r => {
        const a = attempts.get(`${r.id}:${uid}`);
        const st = a && a.status === "in_progress" && now >= r.ends_at ? "expired" : a ? a.status : null;
        return { id: r.id, difficulty: r.difficulty, starts_at: r.starts_at, ends_at: r.ends_at, state: state(r, now),
                 my_status: st, my_elapsed_ms: a ? (a.elapsed_ms ?? null) : null };
      });
      return json(200, { now, rounds: list });
    }
    const r = rounds.get(rid);
    if (route === "POST /v1/rounds/:id/start") {
      if (!r) return json(404, { error: "round_not_found" });
      if (now < r.starts_at) return json(409, { error: "round_not_open" });
      const key = `${rid}:${uid}`, a = attempts.get(key);
      if (!a) {
        if (now >= r.ends_at) return json(409, { error: "round_closed" });
        attempts.set(key, { id: nextAttempt++, round: rid, user: uid, status: "in_progress", started_at: now, wrong: 0, flagged: false });
        return json(200, { round_id: rid, puzzle: r.puzzle, started_at: now, ends_at: r.ends_at, now, resumed: false });
      }
      if (a.status === "in_progress" && now < r.ends_at) return json(200, { round_id: rid, puzzle: r.puzzle, started_at: a.started_at, ends_at: r.ends_at, now, resumed: true });
      return json(409, { error: "already_played" });
    }
    if (route === "POST /v1/rounds/:id/submit") {
      if (!strict(["grid"], ["grid"]) || typeof body.grid !== "string" || !/^[1-9]{81}$/.test(body.grid)) return json(422, { error: "invalid_request" });
      const a = attempts.get(`${rid}:${uid}`);
      if (!a) return json(409, { error: "not_started" });
      if (a.status !== "in_progress") return json(409, { error: "already_played" });
      if (now >= r.ends_at) { a.status = "expired"; return json(409, { error: "round_closed" }); }
      if (isValidCompletion(r.puzzle, body.grid)) {
        Object.assign(a, { status: "solved", finished_at: now, elapsed_ms: now - a.started_at, flagged: now - a.started_at < r.min_solve_ms });
        return json(200, { result: "solved", elapsed_ms: a.elapsed_ms, under_review: a.flagged });
      }
      a.wrong++;
      if (a.wrong >= maxWrong) { a.status = "failed"; a.finished_at = now; return json(200, { result: "failed" }); }
      return json(200, { result: "incorrect", attempts_left: maxWrong - a.wrong });
    }
    if (route === "GET /v1/rounds/:id/leaderboard") {
      if (!r) return json(404, { error: "round_not_found" });
      const w = wins(now);
      const entries = ranked(rid).map((a, k) => { const u = users.get(a.user);
        return { rank: k + 1, pseudo: u.pseudo, avatar: u.avatar, elapsed_ms: a.elapsed_ms, wins: w.get(a.user) || 0, deleted: u.deleted }; });
      const participants = [...attempts.values()].filter(a => a.round === rid).length;
      return json(200, { round_id: rid, state: state(r, now), participants, entries });
    }
    return json(404, { error: "not_found" });
  }
  // Sonde : même 404 qu'une route inconnue sans le bon secret ; le flux est servi d'un bloc
  // (quelques ticks puis « end »), ce qui suffit à tester l'analyse côté page.
  function probe(req, route, body) {
    const [scheme, secret] = (req.headers.authorization || "").split(" ");
    if (scheme !== "Probe" || !fake.probeSecret || secret !== fake.probeSecret) return json(404, { error: "not_found" });
    if (route === "GET /v1/probe/stream") {
      let out = "retry: 2000\n: ouverture\n\n";
      for (let k = 1; k <= fake.probeTicks; k++) out += `id: ${k}\nevent: tick\ndata: ${JSON.stringify({ seq: k, t: clock(), pad: "" })}\n\n`;
      out += 'event: end\ndata: {"reason":"closed"}\n\n';
      return { status: 200, headers: { "content-type": "text/event-stream" }, body: out };
    }
    if (route === "POST /v1/probe/echo" && body && Number.isInteger(body.t)) return json(200, { t: body.t, server: clock() });
    return json(404, { error: "not_found" });
  }
  function state(r, now) { return now < r.starts_at ? "upcoming" : now < r.ends_at ? "open" : "closed"; }
  function ranked(rid) {
    return [...attempts.values()].filter(a => a.round === rid && a.status === "solved" && !a.flagged)
      .sort((a, b) => a.elapsed_ms - b.elapsed_ms || a.finished_at - b.finished_at || a.id - b.id);
  }
  function wins(now) {
    const w = new Map();
    for (const r of rounds.values()) if (r.ends_at <= now) { const first = ranked(r.id)[0]; if (first) w.set(first.user, (w.get(first.user) || 0) + 1); }
    return w;
  }
  return fake;
}
