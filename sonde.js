/* Sonde temps réel du lot 0 (page temporaire). Lit le flux SSE de /v1/probe/stream avec
   fetch (l'en-tête Authorization est impossible avec EventSource) et mesure : retard des
   ticks, arrivée par paquets, coupures, reprises, aller-retour.
   Le secret reste en mémoire : jamais dans l'URL, le stockage du navigateur ou la console. */
(() => {
"use strict";
const API = (() => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const m = meta && /(?:^|;)\s*connect-src\s+([^;]+)/.exec(meta.content);
  const srcs = m ? m[1].trim().split(/\s+/) : [];
  return srcs.length === 1 && /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(srcs[0]) ? srcs[0] : null;
})();
const RE_SECRET = /^sonde_[A-Za-z0-9_-]{43}$/;
const $ = id => document.getElementById(id);

let secret = null, ctl = null, running = false;
const m = {
  started: 0, connections: 0, connStart: 0, longest: 0, ticks: 0, lastSeq: 0, offsets: [],
  gaps: 0, maxGap: 0, bursts: 0, drops: 0, end: null, lastTick: 0, rtts: [], hiddenCount: 0
};

function log(text) {
  const el = $("log"), line = `${new Date().toLocaleTimeString("fr-FR")}  ${text}\n`;
  el.textContent = (line + el.textContent).slice(0, 20000);
}
const pct = (a, p) => { if (!a.length) return "—"; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const secs = ms => `${Math.round(ms / 1000)} s`;

function summary() {
  const base = m.offsets.length ? Math.min(...m.offsets) : 0, jitter = m.offsets.map(o => o - base);
  const conn = navigator.connection ? `${navigator.connection.effectiveType || "?"}${navigator.connection.type ? " / " + navigator.connection.type : ""}` : "inconnu";
  const now = Date.now(), current = running && m.connStart ? now - m.connStart : 0;
  return [
    `Navigateur : ${navigator.userAgent}`,
    `Réseau (indicatif) : ${conn}`,
    `Intervalle / remplissage : ${$("interval").value} s / ${$("pad").value} o`,
    `Durée de la mesure : ${m.started ? secs(now - m.started) : "—"}`,
    `Connexions ouvertes : ${m.connections} (coupures : ${m.drops})`,
    `Plus longue connexion sans coupure : ${secs(Math.max(m.longest, current))}`,
    `Ticks reçus : ${m.ticks} (dernier n° ${m.lastSeq})`,
    `Retard d'un tick p50 / p95 / max : ${pct(jitter, 0.5)} / ${pct(jitter, 0.95)} / ${jitter.length ? Math.round(Math.max(...jitter)) : "—"} ms`,
    `Écarts > 2 × intervalle : ${m.gaps} ; écart max : ${(m.maxGap / 1000).toFixed(2)} s`,
    `Ticks arrivés par paquets (< 50 ms du précédent) : ${m.bursts}`,
    `Page masquée (écran verrouillé, autre appli) : ${m.hiddenCount} fois`,
    `Aller-retour p50 / p95 : ${pct(m.rtts, 0.5)} / ${pct(m.rtts, 0.95)} ms (${m.rtts.length} mesures)`,
    `Fin : ${m.end || (running ? "en cours" : "—")}`,
  ].join("\n");
}
setInterval(() => { if (m.started) $("status").textContent = summary(); }, 1000);

function headers() { return { Authorization: `Probe ${secret}` }; }
const opts = extra => Object.assign({ mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" }, extra);

function onEvent(event, data) {
  if (event === "tick") {
    const now = Date.now(), d = JSON.parse(data), interval = Number($("interval").value) * 1000;
    m.ticks++; m.lastSeq = d.seq;
    if (m.offsets.length < 50000) m.offsets.push(now - d.t);
    if (m.lastTick) {
      const gap = now - m.lastTick;
      if (gap > 2 * interval) m.gaps++;
      if (gap < 50) m.bursts++;
      m.maxGap = Math.max(m.maxGap, gap);
    }
    m.lastTick = now;
  } else if (event === "end") {
    m.end = JSON.parse(data).reason;
  }
}

async function readStream() {
  const url = `${API}/v1/probe/stream?interval=${encodeURIComponent($("interval").value)}&pad=${encodeURIComponent($("pad").value)}`;
  while (running) {
    ctl = new AbortController();
    let res;
    try {
      res = await fetch(url, opts({ headers: headers(), signal: ctl.signal }));
    } catch (e) {
      if (!running) return;
      m.drops++; log("Connexion impossible (réseau). Nouvel essai dans 2 s.");
      await new Promise(r => setTimeout(r, 2000)); continue;
    }
    if (res.status === 404) { log("Secret refusé ou sonde fermée (404). Arrêt."); stop(); return; }
    if (res.status === 429) { log("Trop de requêtes (429). Nouvel essai dans 5 s."); await new Promise(r => setTimeout(r, 5000)); continue; }
    if (!res.ok || !res.body) { log(`Réponse inattendue (${res.status}). Arrêt.`); stop(); return; }
    m.connections++; m.connStart = Date.now(); m.lastTick = 0;
    log(m.connections === 1 ? "Flux ouvert." : "Flux rouvert.");
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let event = "message", data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) onEvent(event, data);
        }
        if (m.end) break;
      }
    } catch (e) { /* coupure pendant la lecture */ }
    m.longest = Math.max(m.longest, Date.now() - m.connStart);
    if (!running) return;
    if (m.end === "expired" || m.end === "closed") { log(`Fin du flux : sonde ${m.end === "expired" ? "expirée" : "fermée"}.`); stop(); return; }
    m.drops++; log("Coupure du flux. Reprise dans 2 s.");
    await new Promise(r => setTimeout(r, 2000));
  }
}

function start() {
  const value = $("secret").value.trim();
  if (value) secret = value;
  if (!API) { log("Adresse de l'API introuvable dans la CSP."); return; }
  if (!secret || !RE_SECRET.test(secret)) { log("Secret absent ou mal formé (sonde_…)."); return; }
  $("secret").value = "";  // il reste en mémoire seulement, pour les reprises
  Object.assign(m, { started: Date.now(), connections: 0, connStart: 0, longest: 0, ticks: 0, lastSeq: 0, offsets: [], gaps: 0, maxGap: 0, bursts: 0, drops: 0, end: null, lastTick: 0, hiddenCount: 0 });
  running = true; $("start").disabled = true; $("stop").disabled = false;
  readStream();
}
function stop() {
  if (running && m.connStart) m.longest = Math.max(m.longest, Date.now() - m.connStart);
  running = false; if (ctl) ctl.abort();
  $("start").disabled = false; $("stop").disabled = true;
  $("status").textContent = summary();
}
async function echo() {
  const value = $("secret").value.trim();
  if (value) { secret = value; $("secret").value = ""; }
  if (!API || !secret || !RE_SECRET.test(secret)) { log("Secret absent ou mal formé (sonde_…)."); return; }
  $("echo").disabled = true;
  for (let k = 0; k < 20; k++) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${API}/v1/probe/echo`, opts({ method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ t: Date.now() }) }));
      if (r.status === 404) { log("Secret refusé ou sonde fermée (404)."); break; }
      if (r.ok) m.rtts.push(performance.now() - t0);
    } catch (e) { log("Aller-retour impossible (réseau)."); }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!m.started) m.started = Date.now();
  $("echo").disabled = false; $("status").textContent = summary();
}
async function copy() {
  const text = summary();
  try { await navigator.clipboard.writeText(text); log("Résultats copiés."); }
  catch (e) { $("status").textContent = text; log("Copie impossible : sélectionne le texte ci-dessus."); }
}

$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
$("echo").addEventListener("click", echo);
$("copy").addEventListener("click", copy);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) m.hiddenCount++;
  log(document.hidden ? "Page masquée." : "Page de nouveau visible.");
});
window.addEventListener("online", () => log("Réseau : en ligne."));
window.addEventListener("offline", () => log("Réseau : hors ligne."));
})();
