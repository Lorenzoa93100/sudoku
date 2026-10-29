/* Mode tournoi : écran séparé du jeu solo, qui ne fait que parler à l'API.
   Règles : le serveur est l'autorité (grille, temps, validation) ; tout ce qu'il renvoie est
   affiché avec textContent, jamais innerHTML ; aucun temps n'est envoyé ; pas d'aides. */
(() => {
"use strict";

/* ---------- Configuration ---------- */
// L'URL de l'API n'est écrite qu'à un endroit : la directive connect-src de la CSP d'index.html.
// On la relit ici : si elle change, la CSP et le code restent forcément d'accord.
const API = (() => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const m = meta && /(?:^|;)\s*connect-src\s+([^;]+)/.exec(meta.content);
  const srcs = m ? m[1].trim().split(/\s+/) : [];
  return srcs.length === 1 && /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(srcs[0]) ? srcs[0] : null;
})();
// Clés propres au jeu : toutes les pages de lorenzoa93100.github.io partagent ce localStorage.
const TOKEN_KEY = "sudoku-tournoi-token";
const GRID_KEY = id => `sudoku-tournoi-grille-${id}`;
// Copie de la galerie du serveur (app/avatars.py) : identifiant → emoji.
const AVATARS = {
  chat: "🐱", chien: "🐶", renard: "🦊", panda: "🐼", koala: "🐨", tigre: "🐯", lion: "🦁",
  grenouille: "🐸", hibou: "🦉", pingouin: "🐧", pieuvre: "🐙", baleine: "🐳", tortue: "🐢",
  abeille: "🐝", papillon: "🦋", licorne: "🦄", dragon: "🐉", fusee: "🚀", etoile: "⭐", cactus: "🌵"
};
const DIFF_NAMES = { facile: "Facile", moyen: "Moyen", difficile: "Difficile", expert: "Expert", extreme: "Extrême" };
const RE_TOKEN = /^[A-Za-z0-9_-]{43}$/, RE_PSEUDO = /^[A-Za-z0-9_-]{3,20}$/;
// Connexion Discord : seule destination de navigation acceptée pour l'URL rendue par l'API.
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize?";
// Connexion en cours (nonce tiré ici), gardée dans sessionStorage : propre à cet onglet.
const LOGIN_KEY = "sudoku-tournoi-connexion";
const LOGIN_TTL_MS = 10 * 60 * 1000;
const REASONS = { cheating: "triche", pseudo: "pseudo inapproprié", abuse: "abus", multi_account: "comptes multiples", other: "autre raison" };
const GENERIC = "Une erreur est survenue. Réessaie plus tard.";

/* ---------- Stockage (localStorage, ou mémoire s'il est indisponible) ---------- */
const storage = (() => {
  const mem = new Map();
  let persistent = false;
  try {
    const k = "sudoku-tournoi-test";
    localStorage.setItem(k, "1"); persistent = localStorage.getItem(k) === "1"; localStorage.removeItem(k);
  } catch (e) { persistent = false; }
  return {
    persistent,
    get(k) {
      if (persistent) { try { return localStorage.getItem(k); } catch (e) { /* mémoire */ } }
      return mem.has(k) ? mem.get(k) : null;
    },
    set(k, v) { mem.set(k, v); if (persistent) { try { localStorage.setItem(k, v); } catch (e) { /* plein */ } } },
    del(k) { mem.delete(k); if (persistent) { try { localStorage.removeItem(k); } catch (e) { /* rien */ } } }
  };
})();
// sessionStorage : connexion en cours seulement (nonce), jamais le jeton.
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); return sessionStorage.getItem(k) === v; } catch (e) { return false; } },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* rien */ } }
};
let token = storage.get(TOKEN_KEY);
if (token && !RE_TOKEN.test(token)) { storage.del(TOKEN_KEY); token = null; }

/* ---------- Appels à l'API ---------- */
class ApiError extends Error {
  constructor(kind, status = 0, code = null, wait = 0, data = null) {
    super(kind); this.kind = kind; this.status = status; this.code = code; this.wait = wait; this.data = data;
  }
}
let cooldownUntil = 0;
async function api(method, path, body) {
  if (!API) throw new ApiError("config");
  const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
  if (left > 0) throw new ApiError("rate", 429, null, left);  // pas de requête pendant l'attente
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers, mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  opts.signal = ctl.signal;
  let res, data = null;
  try {
    res = await fetch(API + path, opts);
    const text = await res.text();
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (type === "application/json" && text.length <= 200000) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  } catch (e) { throw new ApiError("network"); }
  finally { clearTimeout(timer); }
  const code = data && typeof data.error === "string" ? data.error : null;
  if (res.ok) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("unexpected", res.status);
    return data;
  }
  if (res.status === 429) {
    // Retry-After n'est lisible que si le serveur l'expose en CORS ; sinon 30 s par défaut.
    const s = parseInt(res.headers.get("retry-after"), 10);
    const wait = Number.isFinite(s) && s > 0 ? Math.min(s, 3600) : 30;
    cooldownUntil = Date.now() + wait * 1000;
    throw new ApiError("rate", 429, code, wait);
  }
  throw new ApiError("http", res.status, code, 0, data);
}

// Codes d'erreur connus → message. Un texte venu du serveur n'est jamais affiché tel quel.
const CODE_MESSAGES = {
  pseudo_taken: "Ce pseudo est déjà pris.",
  pseudo_forbidden: "Ce pseudo n'est pas accepté. Choisis-en un autre.",
  invalid_code: "La connexion a expiré. Recommence avec « Se connecter avec Discord ».",
  invalid_ticket: "La connexion a expiré. Recommence avec « Se connecter avec Discord ».",
  account_exists: "Ce compte Discord a déjà un compte de jeu. Reconnecte-toi.",
  signups_closed: "Les inscriptions sont fermées pour le moment (trop de nouveaux comptes). Réessaie plus tard.",
  login_unavailable: "La connexion est indisponible pour le moment. Réessaie plus tard.",
  maintenance: "Le site est en maintenance. Réessaie dans quelques minutes.",
  confirmation_mismatch: "Le pseudo retapé ne correspond pas.",
  already_in_tournament: "Tu es déjà dans un tournoi en cours. Termine-le ou quitte sa salle d'abord.",
  tournament_full: "Ce tournoi est complet.",
  tournament_closed: "Ce tournoi a déjà commencé ou est terminé.",
  not_enough_players: "Il faut au moins 2 joueurs pour lancer la partie.",
  not_creator: "Seul le créateur peut lancer la partie.",
  already_finished: "Tu as déjà terminé ce tournoi.",
  abandon_cooldown: "Trop d'abandons ces dernières 24 h : tu pourras créer ou rejoindre un tournoi dans une heure.",
  tournament_daily_limit: "Tu as déjà créé 10 tournois aujourd'hui. Réessaie demain.",
  tournaments_full: "Trop de tournois en cours sur le site. Réessaie dans quelques minutes.",
  invalid_request: "Le serveur a refusé ces données.",
  round_not_found: "Cette manche n'existe pas.",
  round_not_open: "Cette manche n'a pas encore commencé.",
  round_closed: "Cette manche est terminée.",
  already_played: "Tu as déjà joué cette manche (un seul essai).",
  not_started: "Démarre la manche avant de valider."
};
function messageFor(err) {
  if (!(err instanceof ApiError)) return GENERIC;
  if (err.kind === "config") return "Mode tournoi indisponible : adresse du serveur introuvable.";
  if (err.kind === "network") return "Serveur injoignable. Vérifie ta connexion, puis réessaie.";
  if (err.kind === "rate" && ["signups_closed", "abandon_cooldown", "tournament_daily_limit", "tournaments_full"].includes(err.code)) return CODE_MESSAGES[err.code];
  if (err.kind === "rate") return `Trop de requêtes. Patiente ${err.wait} s avant de réessayer.`;
  if (err.kind === "unexpected") return "Réponse inattendue du serveur. Réessaie plus tard.";
  if (err.code && CODE_MESSAGES[err.code]) return CODE_MESSAGES[err.code];
  if (err.status === 404) return "Introuvable.";
  if (err.status >= 500) return "Le serveur rencontre un problème. Réessaie plus tard.";
  return GENERIC;
}

/* ---------- Contrôle des réponses ---------- */
const isCount = n => Number.isSafeInteger(n) && n >= 0;
const isText = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max;
function check(ok) { if (!ok) throw new ApiError("unexpected"); }
function checkMe(d) {
  check(isText(d.pseudo, 40) && isText(d.avatar, 32) && isCount(d.wins) && isCount(d.created_at)
    && Array.isArray(d.warnings) && d.warnings.length <= 10);
  for (const w of d.warnings) check(w && isCount(w.created_at) && typeof w.reason === "string");
  return d;
}
function checkRounds(d) {
  check(isCount(d.now) && Array.isArray(d.rounds) && d.rounds.length <= 200);
  for (const r of d.rounds) {
    check(r && isCount(r.id) && DIFF_NAMES[r.difficulty] && isCount(r.starts_at) && isCount(r.ends_at)
      && ["upcoming", "open", "closed"].includes(r.state)
      && (r.my_status === null || ["in_progress", "solved", "failed", "expired"].includes(r.my_status))
      && (r.my_elapsed_ms === null || isCount(r.my_elapsed_ms)));
  }
  return d;
}
function checkStart(d) {
  check(isCount(d.round_id) && typeof d.puzzle === "string" && /^[0-9]{81}$/.test(d.puzzle)
    && isCount(d.started_at) && isCount(d.ends_at) && isCount(d.now));
  return d;
}
function checkSubmit(d) {
  check(["solved", "incorrect", "failed"].includes(d.result));
  if (d.result === "solved") check(isCount(d.elapsed_ms) && typeof d.under_review === "boolean");
  if (d.result === "incorrect") check(isCount(d.attempts_left));
  return d;
}
function checkBoard(d) {
  check(isCount(d.round_id) && ["upcoming", "open", "closed"].includes(d.state) && isCount(d.participants)
    && Array.isArray(d.entries) && d.entries.length <= 500);
  for (const e of d.entries) {
    // Compte supprimé : pseudo et avatar à null, affiché « Joueur supprimé ».
    check(e && isCount(e.rank) && isCount(e.elapsed_ms) && isCount(e.wins) && typeof e.deleted === "boolean"
      && (e.deleted ? e.pseudo === null && e.avatar === null : isText(e.pseudo, 40) && isText(e.avatar, 32)));
  }
  return d;
}

/* ---------- Outils d'affichage (textContent uniquement) ---------- */
const $ = id => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const emoji = id => (Object.prototype.hasOwnProperty.call(AVATARS, id) ? AVATARS[id] : "❔");
function fmtMs(ms) {
  const t = Math.floor(ms / 100), d = t % 10, s = Math.floor(t / 10) % 60, m = Math.floor(t / 600) % 60, h = Math.floor(t / 36000);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")},${d}`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0")) + ":" + String(s % 60).padStart(2, "0");
}
const dateFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDate = ms => dateFmt.format(new Date(ms));

const VIEWS = ["vLogin", "vSignup", "vLobby", "vPlay", "vBoard", "vAccount", "vCreate", "vJoin", "vRoom", "vRanking"];
let current = null;
function show(view) { current = view; for (const v of VIEWS) $(v).hidden = v !== view; }
function say(text, kind) {
  const m = $("tMsg");
  m.textContent = text || ""; m.className = "tmsg" + (kind ? ` ${kind}` : ""); m.hidden = !text;
}
// Exécute une action réseau : boutons désactivés pendant l'appel, erreurs centralisées.
async function run(buttons, fn) {
  for (const b of buttons) b.disabled = true;
  try { return await fn(); }
  catch (err) { handleError(err); return undefined; }
  finally { for (const b of buttons) b.disabled = false; holdDuringCooldown(); }
}
function handleError(err) {
  if (err instanceof ApiError && err.kind === "http" && err.status === 401) {
    if (err.code === "invalid_code" || err.code === "invalid_ticket") { showLogin(); say(messageFor(err), "err"); return; }
    forget("Ta session a expiré. Reconnecte-toi avec Discord.");
    return;
  }
  if (err instanceof ApiError && err.kind === "http" && err.status === 403) { showLogin(); say(blockedMessage(err), "err"); return; }
  say(messageFor(err), "err");
}
// Compte suspendu ou banni : raison (code connu uniquement) et date de fin.
function blockedMessage(err) {
  const d = err.data || {}, why = Object.prototype.hasOwnProperty.call(REASONS, d.reason) ? ` (raison : ${REASONS[d.reason]})` : "";
  if (err.code === "account_suspended" && isCount(d.until)) return `Ton compte est suspendu jusqu'au ${fmtDate(d.until)}${why}.`;
  if (err.code === "account_banned") return `Ton compte est banni${why}. Pour contester, passe par le salon Discord du jeu.`;
  return GENERIC;
}
// Pendant une attente imposée (429), les boutons restent grisés ; aucune requête n'est relancée.
let cooldownTimer = null;
function holdDuringCooldown() {
  const left = cooldownUntil - Date.now();
  if (left <= 0) return;
  const btns = [...$("tournoi").querySelectorAll("button")].filter(b => !b.disabled);
  for (const b of btns) b.disabled = true;
  clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => { for (const b of btns) b.disabled = false; updateSubmit(); say(""); }, left);
}

/* ---------- Session ---------- */
let me = null;
// Oublie la session sur cet appareil (sans appel réseau).
function forget(msg, kind = "err") {
  token = null; me = null; storage.del(TOKEN_KEY);
  $("tMe").hidden = true;
  showLogin();
  if (msg) say(msg, kind);
}
function setMe(d) {
  me = d;
  $("tMeAv").textContent = emoji(d.avatar); $("tMeName").textContent = d.pseudo; $("tMe").hidden = false;
  $("tProfAv").textContent = emoji(d.avatar); $("tProfName").textContent = d.pseudo;
  $("tProfWins").textContent = `${d.wins} victoire${d.wins > 1 ? "s" : ""}`;
}
function startSession(d, welcome) {
  check(RE_TOKEN.test(d.token) && isText(d.pseudo, 40) && isText(d.avatar, 32));
  token = d.token; storage.set(TOKEN_KEY, token);
  return openLobby().then(() => {
    if (welcome) say(storage.persistent ? welcome : `${welcome} Attention : ta session sera perdue en fermant la page.`, storage.persistent ? "ok" : "err");
    // Action demandée avant la connexion (créer, rejoindre par lien, classement).
    const it = takeIntent();
    if (it) return runIntent(it, false);
  });
}

/* ---------- Galerie d'avatars ---------- */
function buildGallery(box, current, onPick) {
  box.replaceChildren();
  for (const [id, em] of Object.entries(AVATARS)) {
    const b = el("button");
    b.type = "button"; b.dataset.avatar = id; b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(id === current)); b.setAttribute("aria-label", id);
    b.append(el("span", "tav", em), el("span", null, id));
    b.addEventListener("click", () => {
      for (const o of box.children) o.setAttribute("aria-checked", String(o === b));
      onPick(id, b);
    });
    box.append(b);
  }
}

/* ---------- Connexion Discord ---------- */
// Aléa du navigateur, encodé en base64url (43 caractères pour 32 octets).
function randomNonce() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function fingerprint(nonce) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)));
  return btoa(String.fromCharCode(...h)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function showLogin() {
  show("vLogin");
  $("tStorageWarn").hidden = storage.persistent;
}
$("tLoginBtn").addEventListener("click", () => run([$("tLoginBtn")], async () => {
  const nonce = randomNonce();
  if (!session.set(LOGIN_KEY, JSON.stringify({ nonce, at: Date.now() }))) {
    say("Ce navigateur bloque le stockage de session : la connexion ne peut pas aboutir. Désactive le blocage pour ce site, ou utilise un autre navigateur.", "err");
    return;
  }
  const d = await api("POST", "/v1/auth/discord/start", { nonce });
  // Seule navigation acceptée : la page d'autorisation de Discord (navigation, pas un fetch).
  check(typeof d.url === "string" && d.url.length <= 2000 && d.url.startsWith(DISCORD_AUTHORIZE));
  say("Redirection vers Discord…");
  location.assign(d.url);
}));

// Retour de Discord : #login=…&state=… ou #login_error=…. Lu une seule fois au chargement,
// puis effacé de l'adresse (historique compris) avant toute autre action.
const loginReturn = (() => {
  const h = location.hash;
  if (!/^#login(?:_error)?=/.test(h)) return null;
  const p = new URLSearchParams(h.slice(1));
  window.history.replaceState(null, "", location.pathname + location.search + "#tournoi");
  return { code: p.get("login"), error: p.get("login_error"), state: p.get("state") };
})();
const LOGIN_ERRORS = {
  expired: "La connexion a expiré ou a déjà servi. Recommence.",
  denied: "Connexion refusée sur Discord.",
  unavailable: "Discord ne répond pas pour le moment. Réessaie plus tard.",
  account_too_young: "Ton compte Discord doit avoir au moins 30 jours pour jouer.",
  rate_limited: "Trop de tentatives. Patiente quelques minutes.",
  maintenance: CODE_MESSAGES.maintenance
};
let signup = null; // { ticket, nonce } : en mémoire seulement, le temps du choix du pseudo
async function finishLogin(ret) {
  const raw = session.get(LOGIN_KEY);
  session.del(LOGIN_KEY);  // une connexion = un seul retour
  let pending = null;
  try { pending = JSON.parse(raw); } catch (e) { pending = null; }
  const ok = pending && typeof pending.nonce === "string" && RE_TOKEN.test(pending.nonce)
    && isCount(pending.at) && Date.now() - pending.at < LOGIN_TTL_MS;
  if (!ok || typeof ret.state !== "string" || ret.state !== await fingerprint(pending.nonce)) {
    // Pas lancée depuis cet onglet (lien piégé, autre navigateur, trop ancienne) : rien n'est envoyé.
    showLogin(); say("Cette connexion n'a pas été lancée depuis cette page, ou elle a expiré. Recommence.", "err");
    return;
  }
  if (ret.error !== null) {
    showLogin(); say(Object.prototype.hasOwnProperty.call(LOGIN_ERRORS, ret.error) ? LOGIN_ERRORS[ret.error] : GENERIC, "err");
    return;
  }
  if (typeof ret.code !== "string" || !RE_TOKEN.test(ret.code)) { showLogin(); say(GENERIC, "err"); return; }
  show(null); say("Connexion…");
  await run([], async () => {
    const d = await api("POST", "/v1/auth/exchange", { code: ret.code, nonce: pending.nonce });
    if (typeof d.signup === "string") {
      check(RE_TOKEN.test(d.signup));
      signup = { ticket: d.signup, nonce: pending.nonce };
      showSignup();
      return;
    }
    await startSession(d, `Content de te revoir, ${d.pseudo} !`);
  });
}

/* ---------- Premier passage : pseudo et avatar ---------- */
let regAvatar = null;
function showSignup() {
  show("vSignup"); say("");
  buildGallery($("tRegGallery"), regAvatar, id => { regAvatar = id; });
}
$("tSignupForm").addEventListener("submit", e => {
  e.preventDefault();
  const pseudo = $("tPseudo").value.trim();
  if (!signup) { showLogin(); say(CODE_MESSAGES.invalid_ticket, "err"); return; }
  if (!RE_PSEUDO.test(pseudo)) { say("Pseudo : 3 à 20 caractères, lettres sans accent, chiffres, - ou _.", "err"); return; }
  if (!regAvatar) { say("Choisis un avatar.", "err"); return; }
  run([$("tSignupBtn")], async () => {
    const d = await api("POST", "/v1/auth/signup", { ticket: signup.ticket, nonce: signup.nonce, pseudo, avatar: regAvatar });
    signup = null; $("tPseudo").value = "";
    await startSession(d, "Bienvenue dans le tournoi !");
  });
});
$("tSignupCancel").addEventListener("click", () => { signup = null; showLogin(); say(""); });

/* ---------- Mon compte ---------- */
const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
function showAccount() {
  if (!me) return;
  $("tAccAv").textContent = emoji(me.avatar); $("tAccName").textContent = me.pseudo;
  $("tAccSince").textContent = `Inscrit le ${dayFmt.format(new Date(me.created_at))} · ${me.wins} victoire${me.wins > 1 ? "s" : ""}`;
  const list = $("tAccWarnList"); list.replaceChildren();
  for (const w of me.warnings) {
    const why = Object.prototype.hasOwnProperty.call(REASONS, w.reason) ? REASONS[w.reason] : REASONS.other;
    list.append(el("li", null, `${dayFmt.format(new Date(w.created_at))} : ${why}`));
  }
  $("tAccWarnings").hidden = me.warnings.length === 0;
  $("tDeleteConfirm").value = ""; $("tDeleteBtn").disabled = true;
  show("vAccount"); say("");
}
$("tAccountBtn").addEventListener("click", () => run([$("tAccountBtn")], async () => {
  setMe(checkMe(await api("GET", "/v1/me"))); showAccount();
}));
$("tAccountBack").addEventListener("click", () => run([$("tAccountBack")], openLobby));
// Déconnexion : la session est fermée côté serveur ; en cas d'échec réseau, elle est quand même
// oubliée sur cet appareil (elle expirera seule).
function logoutWith(path, btn, msg) {
  run([btn], async () => {
    try { await api("POST", path); } catch (err) { if (!(err instanceof ApiError) || err.status !== 401) { forget(`${msg} (le serveur n'a pas pu être prévenu.)`, "ok"); return; } }
    forget(msg, "ok");
  });
}
$("tLogout").addEventListener("click", () => logoutWith("/v1/auth/logout", $("tLogout"), "Tu es déconnecté sur cet appareil."));
$("tLogoutAll").addEventListener("click", () => logoutWith("/v1/auth/logout-all", $("tLogoutAll"), "Tu es déconnecté de tous tes appareils."));
$("tDeleteConfirm").addEventListener("input", () => { $("tDeleteBtn").disabled = !me || $("tDeleteConfirm").value !== me.pseudo; });
$("tDeleteForm").addEventListener("submit", e => {
  e.preventDefault();
  const typed = $("tDeleteConfirm").value;
  if (!me || typed !== me.pseudo) return;
  run([$("tDeleteBtn")], async () => {
    const d = await api("POST", "/v1/me/delete", { confirm_pseudo: typed });
    check(d.deleted === true);
    forget("Ton compte a été supprimé. Merci d'avoir joué !", "ok");
  });
});

/* ---------- Manches ---------- */
const STATE_LABEL = { upcoming: "À venir", open: "En cours", closed: "Terminée" };
const MY_LABEL = { in_progress: "Partie commencée", solved: "Résolue", failed: "Échouée", expired: "Temps écoulé" };
async function openLobby() {
  const [meData, rounds] = [checkMe(await api("GET", "/v1/me")), checkRounds(await api("GET", "/v1/rounds"))];
  setMe(meData);
  renderRounds(rounds);
  let list = null;
  try { list = checkTList(await api("GET", "/v1/tournaments")); }
  catch (err) { if (err instanceof ApiError && err.status === 401) throw err; list = null; }
  renderTournaments(list);
  show("vLobby"); say("");
}
function renderRounds(d) {
  const ul = $("tRounds"); ul.replaceChildren();
  if (!d.rounds.length) { ul.append(el("li", "tempty", "Aucune manche pour l'instant.")); return; }
  for (const r of d.rounds) {
    const li = el("li"), info = el("div", "tinfo"), btns = el("div", "tbtns");
    const title = el("b", null, `Manche ${r.id} · ${DIFF_NAMES[r.difficulty]}`);
    title.append(el("span", `tbadge ${r.state}`, STATE_LABEL[r.state]));
    info.append(title, el("span", null, `${fmtDate(r.starts_at)} → ${fmtDate(r.ends_at)}`));
    if (r.my_status) {
      const txt = r.my_status === "solved" && r.my_elapsed_ms !== null ? `Résolue en ${fmtMs(r.my_elapsed_ms)}` : MY_LABEL[r.my_status];
      info.append(el("span", "tmine", txt));
    }
    if (r.state === "open" && (r.my_status === null || r.my_status === "in_progress")) {
      const b = el("button", "pill primary", r.my_status ? "Reprendre" : "Jouer");
      b.type = "button"; b.addEventListener("click", () => startRound(r.id, r.difficulty, b));
      btns.append(b);
    }
    if (r.state !== "upcoming") {
      const b = el("button", "pill", "Classement");
      b.type = "button"; b.addEventListener("click", () => openBoard(r.id, b));
      btns.append(b);
    }
    li.append(info, btns); ul.append(li);
  }
}
$("tRefresh").addEventListener("click", () => run([$("tRefresh")], openLobby));
$("tAvBtn").addEventListener("click", () => {
  const g = $("tAvGallery");
  g.hidden = !g.hidden;
  if (!g.hidden) buildGallery(g, me && me.avatar, (id, b) => run([b], async () => {
    const d = await api("POST", "/v1/me/avatar", { avatar: id });
    check(d.avatar === id);
    setMe(Object.assign({}, me, { avatar: id })); g.hidden = true;
    say("Avatar changé.", "ok");
  }));
});

/* ---------- Partie ---------- */
let P = null; // { id, difficulty, puzzle[], values[], notes[], startedAt, endsAt, offset, done }
let selected = 0, noteMode = false, clock = null;
const cells = [];
(function buildBoard() {
  const board = $("tBoard");
  for (let i = 0; i < 81; i++) {
    const b = el("button", `cell r${(i / 9) | 0} c${i % 9}`);
    b.type = "button"; b.setAttribute("role", "gridcell"); b.tabIndex = -1;
    b.addEventListener("click", () => { selected = i; renderPlay(); b.focus({ preventScroll: true }); });
    board.append(b); cells.push(b);
  }
  const pad = $("tPad");
  for (let d = 1; d <= 9; d++) {
    const b = el("button", "tnum");
    b.type = "button"; b.setAttribute("aria-label", `Chiffre ${d}`); b.append(el("span", "d", String(d)));
    b.addEventListener("click", () => input(d)); pad.append(b);
  }
})();
const serverNow = () => Date.now() + (P ? P.offset : 0);
function saveGrid() { if (P && !P.done) storage.set(P.gridKey, JSON.stringify({ v: P.values, n: P.notes })); }
function loadGrid(key, puzzle) {
  try {
    const s = JSON.parse(storage.get(key) || "null");
    if (s && Array.isArray(s.v) && s.v.length === 81 && Array.isArray(s.n) && s.n.length === 81
        && s.v.every((x, i) => Number.isInteger(x) && x >= 0 && x <= 9 && (!puzzle[i] || x === puzzle[i]))
        && s.n.every(x => Number.isInteger(x) && x >= 0 && x < 1024)) return s;
  } catch (e) { /* sauvegarde illisible : on repart de l'énoncé */ }
  return null;
}
function startRound(id, difficulty, btn) {
  return run([btn], async () => {
    const d = checkStart(await api("POST", `/v1/rounds/${id}/start`));
    const puzzle = [...d.puzzle].map(Number), saved = loadGrid(GRID_KEY(id), puzzle);
    P = { kind: "round", gridKey: GRID_KEY(id), id, difficulty, puzzle, values: saved ? saved.v : puzzle.slice(),
          notes: saved ? saved.n : new Array(81).fill(0), startedAt: d.started_at, endsAt: d.ends_at, offset: d.now - Date.now(), done: false };
    openPlay(`Manche ${id} · ${DIFF_NAMES[difficulty] || ""}`);
  });
}
// Écran de jeu commun aux manches et aux tournois.
function openPlay(title) {
  const t = P.kind === "tournament";
  selected = Math.max(0, P.puzzle.findIndex(x => !x)); noteMode = false;
  $("tPlayLevel").textContent = title;
  $("tResult").hidden = true;
  $("tPlayWarn").hidden = !t; $("tAbandon").hidden = !t;
  $("tPlayBack").textContent = t ? "Salle du tournoi" : "Retour aux manches";
  $("tPlayBoard").textContent = t ? "Joueurs" : "Classement";
  show("vPlay"); say(""); renderPlay(); tick();
  clearInterval(clock); clock = setInterval(tick, 1000);  // affichage seul, aucune requête
}
function tick() {
  if (!P) return;
  if (!P.done) $("tClock").textContent = fmtClock(serverNow() - P.startedAt);
  const left = P.endsAt - serverNow();
  $("tLeft").textContent = left > 0 ? `Fin dans ${fmtClock(left)}` : "Temps écoulé";
  updateSubmit();
}
function input(d) {
  if (!P || P.done || P.puzzle[selected]) return;
  if (noteMode) { if (!P.values[selected]) P.notes[selected] ^= 1 << d; }
  else { P.values[selected] = P.values[selected] === d ? 0 : d; P.notes[selected] = 0; }
  saveGrid(); renderPlay();
}
function erase() {
  if (!P || P.done || P.puzzle[selected]) return;
  P.values[selected] = 0; P.notes[selected] = 0; saveGrid(); renderPlay();
}
function updateSubmit() {
  $("tSubmit").disabled = !P || P.done || P.values.some(v => !v) || P.endsAt <= serverNow() || cooldownUntil > Date.now();
}
function renderPlay() {
  if (!P) return;
  const R = i => (i / 9) | 0, C = i => i % 9, B = i => ((R(i) / 3) | 0) * 3 + ((C(i) / 3) | 0);
  const sv = P.values[selected];
  for (let i = 0; i < 81; i++) {
    const c = cells[i], v = P.values[i], given = !!P.puzzle[i];
    c.className = `cell r${R(i)} c${C(i)} ${given ? "given" : v ? "user" : "empty"}`;
    if (i !== selected && (R(i) === R(selected) || C(i) === C(selected) || B(i) === B(selected))) c.classList.add("peer");
    if (sv && v === sv && i !== selected) c.classList.add("same");
    if (i === selected) c.classList.add("sel");
    c.tabIndex = i === selected ? 0 : -1;
    if (v) { c.replaceChildren(el("span", "val", String(v))); c.setAttribute("aria-label", `L${R(i) + 1}C${C(i) + 1}, ${v}`); }
    else if (P.notes[i]) {
      const n = el("span", "notes");
      for (let d = 1; d <= 9; d++) n.append(el("span", null, P.notes[i] & (1 << d) ? String(d) : ""));
      c.replaceChildren(n); c.setAttribute("aria-label", `L${R(i) + 1}C${C(i) + 1}, notes`);
    } else { c.replaceChildren(); c.setAttribute("aria-label", `L${R(i) + 1}C${C(i) + 1}, vide`); }
  }
  $("tNotes").classList.toggle("on", noteMode);
  $("tNotesBadge").textContent = noteMode ? "ON" : "OFF";
  $("tPad").classList.toggle("notesmode", noteMode);
  updateSubmit();
}
function result(text, kind) { const r = $("tResult"); r.textContent = text; r.className = `tresult ${kind}`; r.hidden = false; }
function finish() { P.done = true; storage.del(P.gridKey); updateSubmit(); if (P.kind === "tournament") $("tAbandon").hidden = true; }
$("tErase").addEventListener("click", erase);
$("tNotes").addEventListener("click", () => { noteMode = !noteMode; renderPlay(); });
$("tSubmit").addEventListener("click", () => {
  if (!P || P.done) return;
  const grid = P.values.join("");
  if (!/^[1-9]{81}$/.test(grid)) return;
  run([$("tSubmit")], async () => {
    try {
      // Seule la grille part : jamais de temps, le serveur le mesure lui-même.
      const path = P.kind === "tournament" ? `/v1/tournaments/${P.id}/submit` : `/v1/rounds/${P.id}/submit`;
      const d = checkSubmit(await api("POST", path, { grid }));
      if (d.result === "solved") {
        finish(); $("tClock").textContent = fmtClock(d.elapsed_ms);
        result(`Grille correcte ! Temps mesuré par le serveur : ${fmtMs(d.elapsed_ms)}.`
          + (d.under_review ? (P.kind === "tournament" ? " Ce temps est très rapide : il ne compte pas pour la victoire."
            : " Ce temps est très rapide : l'organisateur le vérifiera avant qu'il apparaisse au classement.") : ""), "ok");
      } else if (d.result === "incorrect") {
        result(`Grille incorrecte. Essai${d.attempts_left > 1 ? "s" : ""} restant${d.attempts_left > 1 ? "s" : ""} : ${d.attempts_left}.`, "bad");
      } else {
        finish(); result(`Grille incorrecte. Tu n'as plus d'essai pour ${P.kind === "tournament" ? "ce tournoi" : "cette manche"}.`, "bad");
      }
    } catch (err) {
      if (err instanceof ApiError && err.kind === "http" && err.status === 409) { finish(); result(messageFor(err), "bad"); return; }
      throw err;
    } finally { updateSubmit(); }
  });
});
$("tPlayBack").addEventListener("click", () => {
  stopPlay();
  if (P && P.kind === "tournament") { showRoom(); return; }
  run([$("tPlayBack")], openLobby);
});
$("tPlayBoard").addEventListener("click", () => {
  if (!P) return;
  if (P.kind === "tournament") { stopPlay(); showRoom(); return; }
  openBoard(P.id, $("tPlayBoard"));
});
function stopPlay() { clearInterval(clock); clock = null; }

/* ---------- Classement ---------- */
let boardRound = null;
function openBoard(id, btn) {
  return run([btn], async () => {
    const d = checkBoard(await api("GET", `/v1/rounds/${id}/leaderboard`));
    boardRound = id; stopPlay();
    $("tBoardTitle").textContent = `Classement · manche ${id}`;
    const st = $("tBoardState");
    st.textContent = d.state === "closed" ? "Manche terminée : classement définitif."
      : d.state === "open" ? "Manche en cours : classement provisoire." : "Manche pas encore commencée.";
    st.className = `tstate ${d.state}`;
    const rows = $("tBoardRows"); rows.replaceChildren();
    for (const e of d.entries) {
      const tr = el("tr", !e.deleted && me && e.pseudo === me.pseudo ? "me" : null);
      tr.append(el("td", null, String(e.rank)), el("td", "tav", e.deleted ? "👤" : emoji(e.avatar)),
                el("td", e.deleted ? "tp tdel" : "tp", e.deleted ? "Joueur supprimé" : e.pseudo),
                el("td", null, fmtMs(e.elapsed_ms)), el("td", null, String(e.wins)));
      if (d.state === "closed" && e.rank === 1) tr.classList.add("win");
      rows.append(tr);
    }
    $("tBoardEmpty").hidden = d.entries.length > 0;
    $("tBoardCount").textContent = `${d.participants} participant${d.participants > 1 ? "s" : ""}`;
    show("vBoard"); say("");
  });
}
$("tBoardRefresh").addEventListener("click", () => { if (boardRound) openBoard(boardRound, $("tBoardRefresh")); });
$("tBoardBack").addEventListener("click", () => run([$("tBoardBack")], openLobby));

/* ---------- Tournois créés par les joueurs ---------- */
const T_STATES = ["lobby", "running", "finished", "expired", "cancelled"];
const P_STATUS = ["lobby", "playing", "solved", "failed", "abandoned", "expired"];
const T_DIFFS = ["facile", "moyen", "difficile"];
const RE_TCODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;
const T_STATE_LABEL = { lobby: "Salle d'attente", running: "En cours", finished: "Terminé", expired: "Expiré", cancelled: "Fermé" };
const P_STATUS_LABEL = { lobby: "dans la salle", playing: "en jeu", solved: "résolue", failed: "échouée", abandoned: "abandon", expired: "temps écoulé" };
const maybeCount = v => v === null || isCount(v);
function checkPlayer(p) {
  check(p && typeof p.deleted === "boolean" && typeof p.me === "boolean" && typeof p.creator === "boolean"
    && P_STATUS.includes(p.status) && maybeCount(p.rank) && maybeCount(p.elapsed_ms)
    && (p.deleted ? p.pseudo === null && p.avatar === null : isText(p.pseudo, 40) && isText(p.avatar, 32)));
}
function checkTournament(d) {
  check(isCount(d.id) && isText(d.name, 60) && T_DIFFS.includes(d.difficulty) && Number.isInteger(d.max_players)
    && d.max_players >= 2 && d.max_players <= 10 && T_STATES.includes(d.state) && isCount(d.now)
    && typeof d.is_creator === "boolean" && (d.code === null || RE_TCODE.test(d.code))
    && maybeCount(d.lobby_expires_at) && maybeCount(d.starts_at) && maybeCount(d.ends_at)
    && Array.isArray(d.players) && d.players.length >= 1 && d.players.length <= 10
    && P_STATUS.includes(d.my_status) && typeof d.under_review === "boolean" && isCount(d.attempts_left)
    && isCount(d.absence_s) && (d.winner_counted === null || typeof d.winner_counted === "boolean")
    && (d.puzzle === undefined || (typeof d.puzzle === "string" && /^[0-9]{81}$/.test(d.puzzle))));
  d.players.forEach(checkPlayer);
  return d;
}
function checkTList(d) {
  check(isCount(d.now) && Array.isArray(d.tournaments) && d.tournaments.length <= 50);
  for (const t of d.tournaments) {
    check(t && isCount(t.id) && isText(t.name, 60) && T_DIFFS.includes(t.difficulty) && T_STATES.includes(t.state)
      && isCount(t.players) && isCount(t.max_players) && P_STATUS.includes(t.my_status) && isCount(t.created_at));
  }
  return d;
}
function checkRanking(d) {
  check(Array.isArray(d.entries) && d.entries.length <= 10 && isCount(d.players) && d.me
    && maybeCount(d.me.rank) && isCount(d.me.wins));
  for (const e of d.entries) {
    check(e && isCount(e.rank) && isCount(e.wins) && typeof e.deleted === "boolean" && typeof e.me === "boolean"
      && (e.deleted ? e.pseudo === null && e.avatar === null : isText(e.pseudo, 40) && isText(e.avatar, 32)));
  }
  return d;
}
const normCode = raw => String(raw || "").replace(/[\s-]+/g, "").toUpperCase();

// Intention venue de l'accueil ou d'un lien (#t=CODE), gardée le temps d'une connexion Discord.
const INTENT_KEY = "sudoku-tournoi-intention";
function keepIntent(it) { session.set(INTENT_KEY, JSON.stringify(it)); }
function takeIntent() {
  const raw = session.get(INTENT_KEY); session.del(INTENT_KEY);
  try {
    const it = JSON.parse(raw);
    if (it && ["create", "join", "ranking"].includes(it.kind) && (it.code === undefined || typeof it.code === "string")) return it;
  } catch (e) { /* ignorée */ }
  return null;
}
function runIntent(it, wrap = true) {
  if (it.kind === "create") { showCreate(); return undefined; }
  if (it.kind === "ranking") return wrap ? run([], openRanking) : openRanking();
  if (it.code !== undefined) {
    const code = normCode(it.code);
    if (RE_TCODE.test(code)) return wrap ? run([], () => joinWith(code)) : joinWith(code);
    showJoin(); say("Ce lien de tournoi n'est pas valide. Entre le code à la main.", "err");
    return undefined;
  }
  showJoin(); return undefined;
}

/* Mes tournois (salon) */
function renderTournaments(d) {
  const ul = $("tTournaments"); ul.replaceChildren();
  if (!d) { ul.append(el("li", "tempty", "Tournois indisponibles pour le moment.")); return; }
  if (!d.tournaments.length) { ul.append(el("li", "tempty", "Aucun tournoi récent. Crées-en un, ou rejoins celui d'un ami.")); return; }
  for (const t of d.tournaments) {
    const li = el("li"), info = el("div", "tinfo"), btns = el("div", "tbtns");
    const title = el("b", null, `${t.name} · ${DIFF_NAMES[t.difficulty]}`);
    title.append(el("span", `tbadge ${t.state === "running" ? "open" : t.state === "lobby" ? "upcoming" : "closed"}`, T_STATE_LABEL[t.state]));
    info.append(title, el("span", null, `${t.players}/${t.max_players} joueurs · ${fmtDate(t.created_at)}`));
    const b = el("button", "pill", "Ouvrir");
    b.type = "button"; b.addEventListener("click", () => run([b], () => openRoom(t.id)));
    btns.append(b); li.append(info, btns); ul.append(li);
  }
}
$("tGoCreate").addEventListener("click", showCreate);
$("tGoJoin").addEventListener("click", showJoin);
$("tGoRanking").addEventListener("click", () => run([$("tGoRanking")], openRanking));

/* Créer */
let createDiff = "facile";
function showCreate() { show("vCreate"); say(""); }
for (const b of $("tCreateDiff").children) {
  b.addEventListener("click", () => {
    createDiff = b.dataset.diff;
    for (const o of $("tCreateDiff").children) o.setAttribute("aria-checked", String(o === b));
  });
}
$("tCreateForm").addEventListener("submit", e => {
  e.preventDefault();
  const n = Number($("tCreatePlayers").value);
  if (!T_DIFFS.includes(createDiff) || !Number.isInteger(n) || n < 2 || n > 10) return;
  run([$("tCreateBtn")], async () => {
    const d = checkTournament(await api("POST", "/v1/tournaments", { difficulty: createDiff, max_players: n }));
    enterRoom(d);
    say("Tournoi créé ! Partage le code avec tes amis.", "ok");
  });
});
$("tCreateCancel").addEventListener("click", () => run([$("tCreateCancel")], openLobby));

/* Rejoindre */
function showJoin() { show("vJoin"); say(""); $("tJoinCode").value = ""; }
async function joinWith(code) {
  try {
    enterRoom(checkTournament(await api("POST", "/v1/tournaments/join", { code })));
  } catch (err) {
    if (err instanceof ApiError && err.kind === "http" && err.status === 404) {
      showJoin(); say("Code inconnu, ou tournoi déjà terminé.", "err"); return;
    }
    if (err instanceof ApiError && err.kind === "http" && err.status === 409) { showJoin(); say(messageFor(err), "err"); return; }
    throw err;
  }
}
$("tJoinForm").addEventListener("submit", e => {
  e.preventDefault();
  const code = normCode($("tJoinCode").value);
  if (!RE_TCODE.test(code)) { say("Le code fait 10 caractères (lettres et chiffres, sans I, L, O, 0 ni 1).", "err"); return; }
  run([$("tJoinBtn")], () => joinWith(code));
});
$("tJoinCancel").addEventListener("click", () => run([$("tJoinCancel")], openLobby));

/* Salle d'attente et suivi de la partie : rafraîchissement régulier (3 s, 1 s pendant le
   compte à rebours), suspendu quand la page est cachée et relancé à son retour. */
let room = null, roomOffset = 0, pollTimer = null;
const roomNow = () => Date.now() + roomOffset;
const isOver = d => ["finished", "expired", "cancelled"].includes(d.state);
async function openRoom(id) {
  enterRoom(checkTournament(await api("GET", `/v1/tournaments/${id}`)));
}
function enterRoom(d) {
  room = d; roomOffset = d.now - Date.now();
  showRoom();
}
function showRoom() {
  if (!room) return;
  renderRoom(); show("vRoom"); say("");
  maybePlay();
  schedulePoll();
}
function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }
function schedulePoll() {
  stopPoll();
  if (!active || !room || isOver(room) || document.hidden) return;
  const countdown = room.state === "running" && roomNow() < room.starts_at;
  pollTimer = setTimeout(poll, countdown ? 1000 : 3000);
}
async function poll() {
  pollTimer = null;
  if (!room) return;
  try {
    const d = checkTournament(await api("GET", `/v1/tournaments/${room.id}`));
    if (!room || d.id !== room.id) return;
    room = d; roomOffset = d.now - Date.now();
    if (current === "vRoom") { renderRoom(); maybePlay(); }
  } catch (err) {
    if (err instanceof ApiError && err.kind === "http" && err.status === 404) {
      room = null; stopPoll(); run([], openLobby).then(() => say("Ce tournoi n'est plus accessible.", "err")); return;
    }
    if (err instanceof ApiError && err.kind === "http" && err.status === 401) { handleError(err); return; }
    // Réseau ou 429 : on réessaie au prochain tour, sans bruit.
  }
  schedulePoll();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopPoll(); return; }
  if (active && room && !isOver(room)) { stopPoll(); poll(); }
});
const clockFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
function renderRoom() {
  const d = room;
  $("tRoomName").textContent = d.name;
  $("tRoomInfo").textContent = `${DIFF_NAMES[d.difficulty]} · ${d.players.length}/${d.max_players} joueurs`;
  $("tRoomCodeBox").hidden = !(d.state === "lobby" && d.code);
  $("tRoomCode").textContent = d.code || "";
  const st = $("tRoomState"), now = roomNow();
  let text, cls = d.state === "running" ? "open" : d.state === "lobby" ? "upcoming" : "closed";
  if (d.state === "lobby") {
    text = `Salle d'attente : ${d.is_creator ? "lance la partie" : "le créateur lance la partie"} dès 2 joueurs. Elle expire à ${clockFmt.format(new Date(d.lobby_expires_at - roomOffset))}.`;
  } else if (d.state === "running" && now < d.starts_at) {
    text = `Départ dans ${Math.ceil((d.starts_at - now) / 1000)} s…`;
  } else if (d.state === "running") {
    text = `Partie en cours · fin à ${clockFmt.format(new Date(d.ends_at - roomOffset))}.`;
  } else if (d.state === "finished") {
    const ranked = d.players.filter(p => p.rank !== null).length;
    text = ranked < 2 ? "Tournoi terminé. Pas de vainqueur : il faut au moins 2 grilles résolues."
      : d.winner_counted ? "Tournoi terminé : victoire comptée au classement."
      : "Tournoi terminé. Victoire non comptée (compte trop récent, trop peu de grilles résolues, ou mêmes adversaires trop souvent).";
  } else if (d.state === "expired") text = "Salle expirée : la partie n'a pas été lancée à temps.";
  else text = "Le créateur a fermé la salle.";
  st.textContent = text; st.className = `tstate ${cls}`;
  const ul = $("tRoomPlayers"); ul.replaceChildren();
  for (const p of d.players) {
    const li = el("li", p.me ? "me" : null);
    let status = P_STATUS_LABEL[p.status];
    if (p.status === "solved") status = p.rank !== null ? `${p.rank}ᵉ · ${fmtMs(p.elapsed_ms)}`
      : p.me && d.under_review ? `résolue en ${fmtMs(p.elapsed_ms)} (temps trop rapide, hors classement)` : "résolue";
    const name = el("span", "tp", p.deleted ? "Joueur supprimé" : p.pseudo);
    if (p.creator) name.append(el("span", "tst", " · créateur"));
    if (p.me) name.append(el("span", "tst", " · toi"));
    li.append(el("span", "tav", p.deleted ? "👤" : emoji(p.avatar)), name, el("span", "tst", status));
    ul.append(li);
  }
  const lobby = d.state === "lobby";
  $("tRoomStart").hidden = !(lobby && d.is_creator);
  $("tRoomStart").disabled = d.players.length < 2;
  $("tRoomPlay").hidden = !(d.state === "running" && d.my_status === "playing" && now >= d.starts_at);
  $("tRoomLeave").hidden = !lobby;
  $("tRoomLeave").textContent = d.is_creator ? "Fermer la salle" : "Quitter la salle";
  $("tRoomWarn").hidden = isOver(d) || (d.state === "running" && d.my_status !== "playing");
}
// Dès que la grille est servie, on passe à la partie (une seule fois, depuis la salle).
function maybePlay() {
  const d = room;
  if (!d || current !== "vRoom" || d.state !== "running" || d.my_status !== "playing" || !d.puzzle) return;
  if (P && P.kind === "tournament" && P.id === d.id) return;
  startTournamentPlay();
}
function startTournamentPlay() {
  const d = room;
  if (!d || !d.puzzle) return;
  const key = GRID_KEY(`t${d.id}`), puzzle = [...d.puzzle].map(Number), saved = loadGrid(key, puzzle);
  P = { kind: "tournament", gridKey: key, id: d.id, difficulty: d.difficulty, puzzle, values: saved ? saved.v : puzzle.slice(),
        notes: saved ? saved.n : new Array(81).fill(0), startedAt: d.starts_at, endsAt: d.ends_at, offset: roomOffset, done: false };
  openPlay(`${d.name} · ${DIFF_NAMES[d.difficulty]}`);
  schedulePoll();  // la présence continue pendant la partie
}
$("tRoomPlay").addEventListener("click", () => {
  if (P && P.kind === "tournament" && room && P.id === room.id) { openPlay(`${room.name} · ${DIFF_NAMES[room.difficulty]}`); schedulePoll(); }
  else startTournamentPlay();
});
$("tRoomStart").addEventListener("click", () => run([$("tRoomStart")], async () => {
  enterRoom(checkTournament(await api("POST", `/v1/tournaments/${room.id}/start`)));
}));
$("tRoomShare").addEventListener("click", async () => {
  if (!room || !room.code) return;
  const link = `${location.origin}${location.pathname}#t=${room.code}`;
  const text = `Rejoins mon tournoi de Sudoku « ${room.name} » : code ${room.code}`;
  try {
    if (navigator.share) { await navigator.share({ title: "Tournoi de Sudoku", text, url: link }); return; }
    await navigator.clipboard.writeText(`${text}\n${link}`);
    say("Lien et code copiés.", "ok");
  } catch (e) { say(`Code à transmettre : ${room.code}`, "ok"); }
});
$("tRoomLeave").addEventListener("click", () => {
  if (!room || room.state !== "lobby") return;
  if (room.is_creator && !window.confirm("Fermer la salle ? Les autres joueurs ne pourront plus jouer ce tournoi.")) return;
  run([$("tRoomLeave")], async () => {
    const d = await api("POST", `/v1/tournaments/${room.id}/leave`);
    check(d.result === "cancelled" || d.result === "left");
    room = null; stopPoll();
    await openLobby();
    say(d.result === "cancelled" ? "Salle fermée." : "Tu as quitté la salle.", "ok");
  });
});
$("tRoomBack").addEventListener("click", () => run([$("tRoomBack")], openLobby));
$("tAbandon").addEventListener("click", () => {
  if (!P || P.kind !== "tournament" || P.done) return;
  if (!window.confirm("Abandonner ce tournoi ? Tu ne pourras plus y revenir.")) return;
  run([$("tAbandon")], async () => {
    const d = await api("POST", `/v1/tournaments/${P.id}/leave`);
    check(d.result === "abandoned");
    finish(); stopPlay();
    room = checkTournament(await api("GET", `/v1/tournaments/${P.id}`));
    showRoom();
    say("Tu as abandonné ce tournoi.", "ok");
  });
});

/* Classement global */
async function openRanking() {
  const d = checkRanking(await api("GET", "/v1/leaderboard"));
  const rows = $("tRankRows"); rows.replaceChildren();
  for (const e of d.entries) {
    const tr = el("tr", e.me ? "me" : null);
    tr.append(el("td", null, String(e.rank)), el("td", "tav", e.deleted ? "👤" : emoji(e.avatar)),
              el("td", e.deleted ? "tp tdel" : "tp", e.deleted ? "Joueur supprimé" : e.pseudo), el("td", null, String(e.wins)));
    rows.append(tr);
  }
  $("tRankEmpty").hidden = d.entries.length > 0;
  $("tRankMe").textContent = d.me.rank !== null
    ? `Ta position : ${d.me.rank}ᵉ sur ${d.players} (${d.me.wins} victoire${d.me.wins > 1 ? "s" : ""}).`
    : "Tu n'as pas encore de victoire : gagne un tournoi pour entrer au classement.";
  show("vRanking"); say("");
}
$("tRankRefresh").addEventListener("click", () => run([$("tRankRefresh")], openRanking));
$("tRankBack").addEventListener("click", () => run([$("tRankBack")], openLobby));

/* ---------- Clavier : en mode tournoi, le jeu solo ne reçoit aucune touche ---------- */
let active = false;
window.addEventListener("keydown", e => {
  if (!active) return;
  e.stopPropagation();  // capture sur window : les raccourcis du solo (aides, pause…) ne partent pas
  if (e.target.closest && e.target.closest("input, textarea")) return;
  if ($("vPlay").hidden || !P || e.ctrlKey || e.metaKey || e.altKey) return;
  const dm = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  const digit = dm ? +dm[1] : /^[0-9]$/.test(e.key) ? +e.key : -1;
  const move = { ArrowUp: 72, ArrowDown: 9 }[e.key];
  if (digit >= 1) input(digit);
  else if (e.key === "Backspace" || e.key === "Delete" || digit === 0) erase();
  else if (e.key.toLowerCase() === "n") { noteMode = !noteMode; renderPlay(); }
  else if (move) selected = (selected + move) % 81;
  else if (e.key === "ArrowLeft") selected = ((selected / 9) | 0) * 9 + (selected % 9 + 8) % 9;
  else if (e.key === "ArrowRight") selected = ((selected / 9) | 0) * 9 + (selected % 9 + 1) % 9;
  else return;
  e.preventDefault(); renderPlay();
  if (e.key.startsWith("Arrow")) cells[selected].focus({ preventScroll: true });
}, true);

/* ---------- Navigation solo ↔ tournoi (#tournoi) ---------- */
let loginPending = loginReturn;  // traité à l'entrée dans le tournoi, une seule fois
function enter(intent = null) {
  active = true;
  $("app").hidden = true; $("tournoi").hidden = false;
  // Le solo est mis en pause et sa fenêtre éventuelle fermée (fonctions globales d'app.js).
  if (typeof closeSheet === "function") closeSheet();
  if (typeof G !== "undefined" && G && !G.done && !G.lost && typeof setPaused === "function") setPaused(true);
  // frame-ancestors est ignoré dans une CSP en <meta> : on refuse nous-mêmes d'être affiché
  // dans un cadre (protection contre le clickjacking des actions du tournoi).
  if (window.top !== window.self) { show(null); say("Le mode tournoi ne s'ouvre pas dans un cadre. Ouvre la page directement.", "err"); return; }
  if (!API) { show(null); say(messageFor(new ApiError("config")), "err"); return; }
  if (loginPending) { const ret = loginPending; loginPending = null; finishLogin(ret); return; }
  if (!token) {
    if (intent) keepIntent(intent);  // reprise après la connexion Discord
    showLogin(); say(intent ? "Connecte-toi pour continuer." : ""); return;
  }
  show(null); say("Chargement…");
  run([], async () => { await openLobby(); if (intent) await runIntent(intent, false); });
}
function leave() {
  active = false; stopPlay(); stopPoll();
  $("tournoi").hidden = true; $("app").hidden = false;
  // Sans partie solo : retour à l'écran d'accueil (app.js).
  if (typeof G !== "undefined" && !G && typeof showHome === "function") showHome(false);
}
// #tournoi : salon. Raccourcis de l'accueil (#tournoi-creer, -rejoindre, -classement) et lien
// de tournoi (#t=CODE) : ouverts puis remplacés par #tournoi dans l'adresse.
const HASH_INTENTS = { "#tournoi-creer": "create", "#tournoi-rejoindre": "join", "#tournoi-classement": "ranking" };
function route() {
  const h = location.hash;
  let intent = null;
  if (Object.prototype.hasOwnProperty.call(HASH_INTENTS, h)) intent = { kind: HASH_INTENTS[h] };
  const m = /^#t=([^&#]{0,40})$/.exec(h);
  if (m) {
    let raw = "";
    try { raw = decodeURIComponent(m[1]); } catch (e) { raw = ""; }
    intent = { kind: "join", code: normCode(raw).slice(0, 20) };
  }
  if (intent) window.history.replaceState(null, "", location.pathname + location.search + "#tournoi");
  const on = intent !== null || location.hash === "#tournoi";
  if (on && !active) enter(intent);
  else if (on && intent && token) runIntent(intent);
  else if (!on && active) leave();
}
$("tBack").addEventListener("click", e => {
  e.preventDefault();
  // window.history : app.js déclare une variable globale « history » (sa pile d'annulation).
  window.history.replaceState(null, "", location.pathname + location.search);
  route();
});
window.addEventListener("hashchange", route);
route();
})();
