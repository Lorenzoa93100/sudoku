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
  const tournaments = new Map();    // id -> tournoi (voir route POST /v1/tournaments)
  const rankedGames = new Map();    // id -> grille classée (voir rankedApi)
  const solvedCounts = new Map();   // userId -> { niveau: grilles résolues } (second score)
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
    countdownMs: 5000,              // compte à rebours des tournois (raccourci dans les tests)
    // Grilles classées (lot 3) : plafond sur 24 h, niveaux dont la réserve est vide, et
    // legacy = serveur d'avant le lot 3 (pas de champ solved, pas de route /v1/ranked).
    rankedPerDay: 10,
    poolEmpty: new Set(),
    legacy: false,
    rankedGame(id) { return rankedGames.get(id); },
    addSolvedCount(uid, level, n = 1) { const c = solvedOf(uid); c[level] += n; },
    tournament(id) { return tournaments.get(id); },
    // Ajoute un joueur (déjà inscrit) dans un tournoi, comme s'il avait saisi le code.
    joinTournament(id, uid) { tournaments.get(id).players.set(uid, { status: "lobby", joined_at: clock(), elapsed: null, finished_at: null, wrong: 0 }); },
    finishPlayer(id, uid, elapsed) { Object.assign(tournaments.get(id).players.get(uid), { status: "solved", elapsed, finished_at: clock() }); },
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
  const LEVELS = ["facile", "moyen", "difficile", "expert", "extreme"];
  function solvedOf(uid) {
    if (!solvedCounts.has(uid)) solvedCounts.set(uid, Object.fromEntries(LEVELS.map(l => [l, 0])));
    return solvedCounts.get(uid);
  }
  const withSolved = (obj, uid) => (fake.legacy ? obj : { ...obj, solved: { ...solvedOf(uid) } });
  const rankedActive = (uid, now) => [...rankedGames.values()].some(g => g.user === uid && g.status === "playing" && g.ends_at > now);

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

    if (req.path === "/v1/leaderboard" || req.path.startsWith("/v1/tournaments")) {
      const r = tournamentApi(req, body, uid, now, strict);
      if (r) return r;
    }
    if (!fake.legacy && (req.path === "/v1/ranked" || req.path.startsWith("/v1/ranked/"))) return rankedApi(req, body, uid, now, strict);
    if (route === "GET /v1/me") return json(200, withSolved({ pseudo: user.pseudo, avatar: user.avatar, created_at: user.created_at,
      wins: wins(now).get(uid) || 0, warnings: user.warnings }, uid));
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
  // --- Tournois : même comportement visible que l'API (privé, départ commun, grille après le départ).
  const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let nextTournament = 1;
  function tRefresh(t, now) {
    if (t.state === "lobby" && now >= t.created_at + 15 * 60_000) t.state = "expired";
    if (t.state === "running" && now >= t.starts_at) {
      if (now >= t.ends_at) for (const p of t.players.values()) if (p.status === "playing") p.status = "expired";
      if (![...t.players.values()].some(p => p.status === "playing")) {
        t.state = "finished";
        t.winner_counted = [...t.players.values()].filter(p => p.status === "solved").length >= 2;
      }
    }
  }
  function tView(t, uid, now) {
    const entries = [...t.players.entries()];
    const solved = entries.filter(([, p]) => p.status === "solved").sort((a, b) => a[1].elapsed - b[1].elapsed);
    const order = [...solved, ...entries.filter(([, p]) => p.status !== "solved").sort((a, b) => a[1].joined_at - b[1].joined_at)];
    const players = order.map(([id, p]) => {
      const u = users.get(id), k = solved.findIndex(([x]) => x === id);
      return { pseudo: u.pseudo, avatar: u.avatar, deleted: u.deleted, status: p.status, me: id === uid,
               creator: id === t.creator, rank: k >= 0 ? k + 1 : null, elapsed_ms: k >= 0 ? p.elapsed : null };
    });
    const mine = t.players.get(uid);
    const out = { id: t.id, name: t.name, difficulty: t.difficulty, max_players: t.max_players, state: t.state, now,
      is_creator: t.creator === uid, code: t.state === "lobby" ? t.code : null,
      lobby_expires_at: t.state === "lobby" ? t.created_at + 15 * 60_000 : null, starts_at: t.starts_at, ends_at: t.ends_at,
      players, my_status: mine.status, under_review: false, attempts_left: maxWrong - mine.wrong, absence_s: 300,
      winner_counted: t.state === "finished" ? t.winner_counted : null };
    if ((t.state === "running" || t.state === "finished") && now >= t.starts_at) out.puzzle = t.puzzle;
    return out;
  }
  function tournamentApi(req, body, uid, now, strict) {
    const route = `${req.method} ${req.path.replace(/\/\d+(\/|$)/, "/:id$1")}`;
    const tid = Number((/^\/v1\/tournaments\/(\d+)/.exec(req.path) || [])[1]);
    if (route === "GET /v1/leaderboard") {
      if (fake.leaderboard) return json(200, fake.leaderboard(uid));
      const wins = new Map();
      for (const t of tournaments.values()) {
        if (t.state !== "finished" || !t.winner_counted) continue;
        const w = [...t.players.entries()].filter(([, p]) => p.status === "solved").sort((a, b) => a[1].elapsed - b[1].elapsed)[0][0];
        wins.set(w, (wins.get(w) || 0) + 1);
      }
      const order = [...wins.entries()].sort((a, b) => b[1] - a[1]);
      const entries = order.slice(0, 10).map(([id, n], k) => { const u = users.get(id);
        return withSolved({ rank: k + 1, pseudo: u.pseudo, avatar: u.avatar, wins: n, deleted: u.deleted, me: id === uid }, id); });
      const k = order.findIndex(([id]) => id === uid);
      return json(200, { entries, players: order.length, me: withSolved({ rank: k >= 0 ? k + 1 : null, wins: wins.get(uid) || 0 }, uid) });
    }
    if (route === "POST /v1/tournaments") {
      if (!strict(["difficulty", "max_players"], ["difficulty", "max_players"]) || !["facile", "moyen", "difficile"].includes(body.difficulty)
        || !Number.isInteger(body.max_players) || body.max_players < 2 || body.max_players > 10) return json(422, { error: "invalid_request" });
      if ([...tournaments.values()].some(t => ["lobby", "running"].includes(t.state) && ["lobby", "playing"].includes((t.players.get(uid) || {}).status)))
        return json(409, { error: "already_in_tournament" });
      if (rankedActive(uid, now)) return json(409, { error: "ranked_in_progress" });
      const id = nextTournament++;
      const code = [...crypto.getRandomValues(new Uint8Array(10))].map(x => CODE_ABC[x % CODE_ABC.length]).join("");
      const t = { id, code, name: "Renard rusé", difficulty: body.difficulty, max_players: body.max_players, creator: uid,
                  state: "lobby", puzzle: PUZZLE, created_at: now, starts_at: null, ends_at: null, players: new Map(), winner_counted: null };
      tournaments.set(id, t); fake.joinTournament(id, uid);
      return json(201, tView(t, uid, now));
    }
    if (route === "POST /v1/tournaments/join") {
      if (!strict(["code"], ["code"]) || typeof body.code !== "string") return json(422, { error: "invalid_request" });
      const t = [...tournaments.values()].find(x => x.code === body.code.replace(/[\s-]/g, "").toUpperCase());
      if (!t) return json(404, { error: "not_found" });
      tRefresh(t, now);
      if (!t.players.has(uid)) {
        if (t.state !== "lobby") return json(409, { error: "tournament_closed" });
        if (t.players.size >= t.max_players) return json(409, { error: "tournament_full" });
        if (rankedActive(uid, now)) return json(409, { error: "ranked_in_progress" });
        fake.joinTournament(t.id, uid);
      }
      return json(200, tView(t, uid, now));
    }
    if (route === "GET /v1/tournaments") {
      const list = [...tournaments.values()].filter(t => t.players.has(uid) && !["expired", "cancelled"].includes(t.state))
        .sort((a, b) => b.created_at - a.created_at).map(t => ({ id: t.id, name: t.name, difficulty: t.difficulty, state: t.state,
          created_at: t.created_at, starts_at: t.starts_at, players: t.players.size, max_players: t.max_players, my_status: t.players.get(uid).status }));
      return json(200, { now, tournaments: list });
    }
    const t = tournaments.get(tid);
    if (!t || !t.players.has(uid)) return tid ? json(404, { error: "not_found" }) : null;
    tRefresh(t, now);
    const me = t.players.get(uid);
    if (route === "GET /v1/tournaments/:id") return json(200, tView(t, uid, now));
    if (route === "POST /v1/tournaments/:id/start") {
      if (t.creator !== uid) return json(403, { error: "not_creator" });
      if (t.state !== "lobby") return json(409, { error: "tournament_closed" });
      if (t.players.size < 2) return json(409, { error: "not_enough_players" });
      Object.assign(t, { state: "running", starts_at: now + fake.countdownMs, ends_at: now + fake.countdownMs + 20 * 60_000 });
      for (const p of t.players.values()) p.status = "playing";
      return json(200, tView(t, uid, now));
    }
    if (route === "POST /v1/tournaments/:id/leave") {
      if (t.state === "lobby") {
        if (t.creator === uid) { t.state = "cancelled"; return json(200, { result: "cancelled" }); }
        t.players.delete(uid); return json(200, { result: "left" });
      }
      if (t.state === "running" && me.status === "playing") { me.status = "abandoned"; tRefresh(t, now); return json(200, { result: "abandoned" }); }
      return json(409, { error: "already_finished" });
    }
    if (route === "POST /v1/tournaments/:id/submit") {
      if (!strict(["grid"], ["grid"]) || typeof body.grid !== "string" || !/^[1-9]{81}$/.test(body.grid)) return json(422, { error: "invalid_request" });
      if (t.state !== "running" || now < t.starts_at) return json(409, { error: "not_started" });
      if (me.status !== "playing") return json(409, { error: "already_finished" });
      if (isValidCompletion(t.puzzle, body.grid)) {
        Object.assign(me, { status: "solved", elapsed: now - t.starts_at, finished_at: now }); tRefresh(t, now);
        solvedOf(uid)[t.difficulty]++;
        return json(200, { result: "solved", elapsed_ms: me.elapsed, under_review: false });
      }
      me.wrong++;
      if (me.wrong >= maxWrong) { me.status = "failed"; tRefresh(t, now); return json(200, { result: "failed" }); }
      return json(200, { result: "incorrect", attempts_left: maxWrong - me.wrong });
    }
    return json(404, { error: "not_found" });
  }
  // --- Grilles classées : même comportement visible que l'API (lot 3).
  const RK_MIN = { facile: 20, moyen: 30, difficile: 45, expert: 60, extreme: 90 };
  let nextRanked = 1;
  function rkExpire(uid, now) {
    for (const g of rankedGames.values()) if (g.user === uid && g.status === "playing" && now >= g.ends_at) Object.assign(g, { status: "expired", finished_at: g.ends_at });
  }
  const rkView = (g, now) => ({ id: g.id, difficulty: g.difficulty, status: g.status, now, started_at: g.started_at, ends_at: g.ends_at,
    puzzle: g.puzzle, elapsed_ms: g.elapsed_ms, attempts_left: maxWrong - g.wrong });
  function rkQuota(uid, now) {
    const rows = [...rankedGames.values()].filter(g => g.user === uid && g.started_at > now - 86_400_000).sort((a, b) => b.started_at - a.started_at);
    return [rows.length, rows.length >= fake.rankedPerDay ? rows[fake.rankedPerDay - 1].started_at + 86_400_000 : null];
  }
  function rankedApi(req, body, uid, now, strict) {
    const route = `${req.method} ${req.path.replace(/\/\d+(\/|$)/, "/:id$1")}`;
    rkExpire(uid, now);
    const active = [...rankedGames.values()].find(g => g.user === uid && g.status === "playing");
    if (route === "GET /v1/ranked") {
      const [today, next] = rkQuota(uid, now);
      return json(200, { now, game: active ? rkView(active, now) : null, today, per_day: fake.rankedPerDay, next_slot_at: next });
    }
    if (route === "POST /v1/ranked/start") {
      if (!strict(["difficulty"], ["difficulty"]) || !LEVELS.includes(body.difficulty)) return json(422, { error: "invalid_request" });
      if (active) return json(200, { ...rkView(active, now), resumed: true });
      if ([...tournaments.values()].some(t => ["lobby", "running"].includes(t.state) && ["lobby", "playing"].includes((t.players.get(uid) || {}).status)))
        return json(409, { error: "already_in_tournament" });
      const [, next] = rkQuota(uid, now);
      if (next !== null) return json(429, { error: "ranked_daily_limit" }, { "retry-after": String(Math.ceil((next - now) / 1000)) });
      if (fake.poolEmpty.has(body.difficulty)) return json(503, { error: "pool_empty" }, { "retry-after": "3600" });
      const g = { id: nextRanked++, user: uid, difficulty: body.difficulty, puzzle: PUZZLE, status: "playing", started_at: now,
                  ends_at: now + RK_MIN[body.difficulty] * 60_000, finished_at: null, elapsed_ms: null, wrong: 0, flagged: false,
                  min_solve_ms: Math.max(20_000, 600 * PUZZLE.split("").filter(c => c === "0").length) };
      rankedGames.set(g.id, g);
      return json(200, { ...rkView(g, now), resumed: false });
    }
    const gid = Number((/^\/v1\/ranked\/(\d+)\//.exec(req.path) || [])[1]);
    const g = rankedGames.get(gid);
    if (!g || g.user !== uid) return json(404, { error: "not_found" });
    if (route === "POST /v1/ranked/:id/abandon") {
      if (g.status !== "playing") return json(409, { error: "already_finished" });
      Object.assign(g, { status: "abandoned", finished_at: now }); return json(200, { result: "abandoned" });
    }
    if (route === "POST /v1/ranked/:id/submit") {
      if (!strict(["grid"], ["grid"]) || typeof body.grid !== "string" || !/^[1-9]{81}$/.test(body.grid)) return json(422, { error: "invalid_request" });
      if (g.status !== "playing") return json(409, { error: "already_finished" });
      if (isValidCompletion(g.puzzle, body.grid)) {
        const elapsed = now - g.started_at;
        Object.assign(g, { status: "solved", finished_at: now, elapsed_ms: elapsed, flagged: elapsed < g.min_solve_ms });
        if (!g.flagged) solvedOf(uid)[g.difficulty]++;  // signalée : ni comptée, ni annoncée au joueur
        return json(200, { result: "solved", elapsed_ms: elapsed });
      }
      g.wrong++;
      if (g.wrong >= maxWrong) { Object.assign(g, { status: "failed", finished_at: now }); return json(200, { result: "failed" }); }
      return json(200, { result: "incorrect", attempts_left: maxWrong - g.wrong });
    }
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
