// Deux serveurs HTTPS locaux qui se font passer pour les vrais domaines (via
// --host-resolver-rules dans Chromium) : le front tel que GitHub Pages le sert sous /sudoku/,
// et le faux serveur d'API. La CSP et le CORS de la page s'appliquent donc exactement comme
// en production, sans rien relâcher.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

export const FRONT_HOST = "lorenzoa93100.github.io";
export const BACKEND_HOST = "jeu.taila17c77.ts.net";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), "sudoku-dev-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
    "-days", "2", "-subj", "/CN=sudoku-dev", "-addext", `subjectAltName=DNS:${FRONT_HOST},DNS:${BACKEND_HOST}`], { stdio: "ignore" });
  return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
}
const listen = (server, port) => new Promise(ok => server.listen(port, "127.0.0.1", () => ok(server.address().port)));

// extra : autres dossiers servis sous d'autres préfixes (ex. l'ancienne version, pour comparer).
export async function startServers({ root, fake, frontPort = 0, apiPort = 0, prefix = "/sudoku/", extra = {} }) {
  const tls = selfSignedCert(), mounts = { ...extra, [prefix]: root };
  const front = https.createServer(tls, (req, res) => {
    const url = new URL(req.url, `https://${FRONT_HOST}`);
    const mount = Object.keys(mounts).find(m => url.pathname.startsWith(m));
    if (!mount) { res.writeHead(404); res.end(); return; }
    const base = resolve(mounts[mount]);
    let rel = decodeURIComponent(url.pathname.slice(mount.length)) || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep) || rel.split("/").some(p => p.startsWith("."))) { res.writeHead(404); res.end(); return; }
    try {
      if (!statSync(file).isFile()) throw new Error();
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(readFileSync(file));
    } catch (e) { res.writeHead(404); res.end(); }
  });
  const api = https.createServer(tls, (req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const r = fake.handle({ method: req.method, path: new URL(req.url, `https://${BACKEND_HOST}`).pathname, headers: req.headers,
                              body: Buffer.concat(chunks).toString("utf8") });
      if (r.abort) { req.socket.destroy(); return; }
      res.writeHead(r.status, r.headers); res.end(r.body);
    });
  });
  const fp = await listen(front, frontPort), ap = await listen(api, apiPort);
  return {
    frontPort: fp, apiPort: ap,
    hostRules: `MAP ${FRONT_HOST} 127.0.0.1:${fp}, MAP ${BACKEND_HOST} 127.0.0.1:${ap}`,
    url: `https://${FRONT_HOST}${prefix}`,
    close: () => Promise.all([new Promise(ok => front.close(ok)), new Promise(ok => api.close(ok))]),
  };
}
