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
const RE_TOKEN = /^[A-Za-z0-9_-]{43}$/, RE_INVITE = /^[A-Za-z0-9_-]{32}$/, RE_PSEUDO = /^[A-Za-z0-9_-]{3,20}$/;
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
let token = storage.get(TOKEN_KEY);
if (token && !RE_TOKEN.test(token)) { storage.del(TOKEN_KEY); token = null; }

/* ---------- Appels à l'API ---------- */
class ApiError extends Error {
  constructor(kind, status = 0, code = null, wait = 0) { super(kind); this.kind = kind; this.status = status; this.code = code; this.wait = wait; }
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
  throw new ApiError("http", res.status, code);
}

// Codes d'erreur connus → message. Un texte venu du serveur n'est jamais affiché tel quel.
const CODE_MESSAGES = {
  invalid_invite: "Code d'invitation invalide, déjà utilisé ou révoqué.",
  pseudo_taken: "Ce pseudo est déjà pris.",
  pseudo_required: "Choisis un pseudo.",
  avatar_required: "Choisis un avatar.",
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
function checkMe(d) { check(isText(d.pseudo, 40) && isText(d.avatar, 32) && isCount(d.wins)); return d; }
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
  for (const e of d.entries) check(e && isCount(e.rank) && isText(e.pseudo, 40) && isText(e.avatar, 32) && isCount(e.elapsed_ms) && isCount(e.wins));
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

const VIEWS = ["vRegister", "vLobby", "vPlay", "vBoard"];
function show(view) { for (const v of VIEWS) $(v).hidden = v !== view; }
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
  if (err instanceof ApiError && err.kind === "http" && err.status === 401 && err.code !== "invalid_invite") {
    logout("Ta session n'est plus valide. Demande un nouveau code d'invitation à l'organisateur.");
    return;
  }
  say(messageFor(err), "err");
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
function logout(msg) {
  token = null; me = null; storage.del(TOKEN_KEY);
  $("tMe").hidden = true;
  showRegister();
  if (msg) say(msg, "err");
}
function setMe(d) {
  me = d;
  $("tMeAv").textContent = emoji(d.avatar); $("tMeName").textContent = d.pseudo; $("tMe").hidden = false;
  $("tProfAv").textContent = emoji(d.avatar); $("tProfName").textContent = d.pseudo;
  $("tProfWins").textContent = `${d.wins} victoire${d.wins > 1 ? "s" : ""}`;
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

/* ---------- Inscription ---------- */
let regAvatar = null;
function showRegister() {
  show("vRegister"); say("");
  $("tStorageWarn").hidden = storage.persistent;
  buildGallery($("tRegGallery"), regAvatar, id => { regAvatar = id; });
}
$("tRegForm").addEventListener("submit", e => {
  e.preventDefault();
  const invite = $("tInvite").value.trim(), pseudo = $("tPseudo").value.trim();
  if (!RE_INVITE.test(invite)) { say("Le code d'invitation fait 32 caractères (lettres, chiffres, - ou _).", "err"); return; }
  if (!RE_PSEUDO.test(pseudo)) { say("Pseudo : 3 à 20 caractères, lettres sans accent, chiffres, - ou _.", "err"); return; }
  if (!regAvatar) { say("Choisis un avatar.", "err"); return; }
  run([$("tRegBtn")], async () => {
    const d = await api("POST", "/v1/register", { invite_code: invite, pseudo, avatar: regAvatar });
    check(RE_TOKEN.test(d.token) && isText(d.pseudo, 40) && isText(d.avatar, 32));
    token = d.token; storage.set(TOKEN_KEY, token);
    $("tInvite").value = "";
    await openLobby();
    say(storage.persistent ? "Bienvenue dans le tournoi !" : "Bienvenue ! Attention : ta session sera perdue en fermant la page.", storage.persistent ? "ok" : "err");
  });
});

/* ---------- Manches ---------- */
const STATE_LABEL = { upcoming: "À venir", open: "En cours", closed: "Terminée" };
const MY_LABEL = { in_progress: "Partie commencée", solved: "Résolue", failed: "Échouée", expired: "Temps écoulé" };
async function openLobby() {
  const [meData, rounds] = [checkMe(await api("GET", "/v1/me")), checkRounds(await api("GET", "/v1/rounds"))];
  setMe(meData);
  renderRounds(rounds);
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
function saveGrid() { if (P && !P.done) storage.set(GRID_KEY(P.id), JSON.stringify({ v: P.values, n: P.notes })); }
function loadGrid(id, puzzle) {
  try {
    const s = JSON.parse(storage.get(GRID_KEY(id)) || "null");
    if (s && Array.isArray(s.v) && s.v.length === 81 && Array.isArray(s.n) && s.n.length === 81
        && s.v.every((x, i) => Number.isInteger(x) && x >= 0 && x <= 9 && (!puzzle[i] || x === puzzle[i]))
        && s.n.every(x => Number.isInteger(x) && x >= 0 && x < 1024)) return s;
  } catch (e) { /* sauvegarde illisible : on repart de l'énoncé */ }
  return null;
}
function startRound(id, difficulty, btn) {
  return run([btn], async () => {
    const d = checkStart(await api("POST", `/v1/rounds/${id}/start`));
    const puzzle = [...d.puzzle].map(Number), saved = loadGrid(id, puzzle);
    P = { id, difficulty, puzzle, values: saved ? saved.v : puzzle.slice(), notes: saved ? saved.n : new Array(81).fill(0),
          startedAt: d.started_at, endsAt: d.ends_at, offset: d.now - Date.now(), done: false };
    selected = Math.max(0, puzzle.findIndex(x => !x)); noteMode = false;
    $("tPlayLevel").textContent = `Manche ${id} · ${DIFF_NAMES[difficulty] || ""}`;
    $("tResult").hidden = true;
    show("vPlay"); say(""); renderPlay(); tick();
    clearInterval(clock); clock = setInterval(tick, 1000);  // affichage seul, aucune requête
  });
}
function tick() {
  if (!P) return;
  if (!P.done) $("tClock").textContent = fmtClock(serverNow() - P.startedAt);
  const left = P.endsAt - serverNow();
  $("tLeft").textContent = left > 0 ? `Fin dans ${fmtClock(left)}` : "Manche terminée";
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
function finish() { P.done = true; storage.del(GRID_KEY(P.id)); updateSubmit(); }
$("tErase").addEventListener("click", erase);
$("tNotes").addEventListener("click", () => { noteMode = !noteMode; renderPlay(); });
$("tSubmit").addEventListener("click", () => {
  if (!P || P.done) return;
  const grid = P.values.join("");
  if (!/^[1-9]{81}$/.test(grid)) return;
  run([$("tSubmit")], async () => {
    try {
      // Seule la grille part : jamais de temps, le serveur le mesure lui-même.
      const d = checkSubmit(await api("POST", `/v1/rounds/${P.id}/submit`, { grid }));
      if (d.result === "solved") {
        finish(); $("tClock").textContent = fmtClock(d.elapsed_ms);
        result(`Grille correcte ! Temps mesuré par le serveur : ${fmtMs(d.elapsed_ms)}.`
          + (d.under_review ? " Ce temps est très rapide : l'organisateur le vérifiera avant qu'il apparaisse au classement." : ""), "ok");
      } else if (d.result === "incorrect") {
        result(`Grille incorrecte. Essai${d.attempts_left > 1 ? "s" : ""} restant${d.attempts_left > 1 ? "s" : ""} : ${d.attempts_left}.`, "bad");
      } else {
        finish(); result("Grille incorrecte. Tu n'as plus d'essai pour cette manche.", "bad");
      }
    } catch (err) {
      if (err instanceof ApiError && err.kind === "http" && err.status === 409) { finish(); result(messageFor(err), "bad"); return; }
      throw err;
    } finally { updateSubmit(); }
  });
});
$("tPlayBack").addEventListener("click", () => { stopPlay(); run([$("tPlayBack")], openLobby); });
$("tPlayBoard").addEventListener("click", () => { if (P) openBoard(P.id, $("tPlayBoard")); });
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
      const tr = el("tr", me && e.pseudo === me.pseudo ? "me" : null);
      tr.append(el("td", null, String(e.rank)), el("td", "tav", emoji(e.avatar)), el("td", "tp", e.pseudo),
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
function enter() {
  active = true;
  $("app").hidden = true; $("tournoi").hidden = false;
  // Le solo est mis en pause et sa fenêtre éventuelle fermée (fonctions globales d'app.js).
  if (typeof closeSheet === "function") closeSheet();
  if (typeof G !== "undefined" && G && !G.done && !G.lost && typeof setPaused === "function") setPaused(true);
  // frame-ancestors est ignoré dans une CSP en <meta> : on refuse nous-mêmes d'être affiché
  // dans un cadre (protection contre le clickjacking des actions du tournoi).
  if (window.top !== window.self) { show(null); say("Le mode tournoi ne s'ouvre pas dans un cadre. Ouvre la page directement.", "err"); return; }
  if (!API) { show(null); say(messageFor(new ApiError("config")), "err"); return; }
  if (!token) { showRegister(); return; }
  show(null); say("Chargement…");
  run([], openLobby);
}
function leave() {
  active = false; stopPlay();
  $("tournoi").hidden = true; $("app").hidden = false;
  // Sans partie solo : retour à l'écran d'accueil (app.js).
  if (typeof G !== "undefined" && !G && typeof showHome === "function") showHome(false);
}
function route() {
  const on = location.hash === "#tournoi";
  if (on && !active) enter(); else if (!on && active) leave();
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
