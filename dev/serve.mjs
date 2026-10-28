// Essai manuel du mode tournoi contre le faux serveur d'API : node dev/serve.mjs
// Affiche la commande Chromium à lancer (domaines redirigés vers ces serveurs locaux).
import { fileURLToPath } from "node:url";
import { createFakeApi } from "./fake-api.mjs";
import { startServers } from "./servers.mjs";

const fake = createFakeApi();
const codes = [fake.addInvite(), fake.addInvite(), fake.addInvite()];
const ami = fake.addUser("Camille", "renard"), autre = fake.addUser("Sacha", "hibou");
const passee = fake.addRound({ difficulty: "moyen", startsIn: -7_200_000, duration: 3_600_000 });
fake.addSolved(passee, ami.id, 312_400, { finishedAt: Date.now() - 4_000_000 });
fake.addSolved(passee, autre.id, 405_100, { finishedAt: Date.now() - 3_900_000 });
fake.addRound({ difficulty: "facile", minSolveMs: 60_000 });
fake.addRound({ difficulty: "expert", startsIn: 86_400_000 });

const s = await startServers({ root: fileURLToPath(new URL("..", import.meta.url)), fake, frontPort: 8443, apiPort: 9443 });
console.log(`Front : ${s.url} (servi localement)\nAPI factice : https://jeu.taila17c77.ts.net (servie localement)\n`);
console.log("Codes d'invitation :\n  " + codes.join("\n  "));
console.log("\nLance Chromium avec un profil jetable :\n");
console.log(`  chromium --user-data-dir="$(mktemp -d)" --ignore-certificate-errors \\\n    --host-resolver-rules="${s.hostRules}" \\\n    ${s.url}#tournoi\n`);
console.log("(certificat auto-signé : ce profil ne doit servir qu'à ce test)  Ctrl+C pour arrêter.");
