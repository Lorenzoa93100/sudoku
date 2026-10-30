# Sudoku

Jeu de sudoku avec aides expliquées, jouable dans le navigateur.

Fichiers : `index.html` (structure et CSP), `app.css`, `app.js` (jeu solo), `tournoi.js` (mode tournoi), `fonts/` (polices hébergées ici, licence SIL OFL). Aucune ressource tierce.

## Personnalisation (Menu → Réglages)

- **Thèmes** : Auto, Clair, Sombre, Papier, Menthe, Lavande, Sakura, Contraste, Océan, Forêt, Minuit.
- **Couleur de tes chiffres** : couleurs prédéfinies (adaptées aux thèmes clairs et sombres) ou couleur perso.
- **Touche du mode crayon** : `N` par défaut, modifiable.

Les réglages, les stats et la partie en cours sont gardés dans le `localStorage` du navigateur.

## Codes de grille et partage

- Chaque grille a un **code** (ex. `E-7KQ2MXP`) : la lettre donne la difficulté, le reste est la seed. Le même code redonne toujours exactement la même grille.
- Le code est affiché sous le nom du niveau pendant toute la partie ; appuyer dessus l'envoie (comme **Menu → Défier un ami**).
- **Menu → Défier un ami** envoie le code et un lien `?g=CODE` qui ouvre directement cette grille.
- **Menu → Jouer avec un code** (ou « J'ai un code de grille » au choix de la difficulté) pour saisir un code reçu.
- En fin de partie, **Partager** envoie le temps, la difficulté, le code et une image de la grille terminée (sur mobile, via le menu de partage du téléphone ; sur ordinateur, le texte est copié et l'image peut être téléchargée).

## Mode tournoi entre amis

Accès : **Nouvelle partie → Tournoi → Rejoindre**, **Nouvelle partie → Grille classée**, **Menu → Mode tournoi entre amis**, ou directement `https://lorenzoa93100.github.io/sudoku/#tournoi`.

- Connexion avec Discord uniquement (permission `identify` : seul l'identifiant Discord est lu, ni nom, ni e-mail ; compte Discord de 30 jours au moins). Au premier passage, choix d'un pseudo et d'un avatar ; le nom Discord n'est jamais affiché.
- **Mon compte** : avertissements éventuels, déconnexion (cet appareil ou tous), suppression du compte (pseudo à retaper). Un compte supprimé apparaît « Joueur supprimé » dans les classements.
- **Tournois entre joueurs** : **Créer** (difficulté facile, moyen ou difficile, 2 à 10 joueurs ; le serveur tire la grille et le nom) donne un code de 10 caractères à partager, ou un lien `…/sudoku/#t=CODE` (le code est retiré de l'adresse dès l'ouverture). Salle d'attente rafraîchie toutes les 3 s (1 s pendant le compte à rebours), suspendue quand la page est cachée. Le créateur lance ; le départ est le même pour tous, fixé par le serveur. Garder la page ouverte : 5 minutes sans nouvelles de l'appareil comptent comme un abandon. Un tournoi n'est visible que de ses participants.
- **Grille classée** (Nouvelle partie → Grille classée, menu ☰, salon, ou `…/sudoku/#tournoi-classee`) : une grille notée tirée par le serveur, au niveau choisi (facile à extrême), chronométrée et validée par lui. Durée maximale affichée sous chaque niveau (20, 30, 45, 60, 90 min), plafond de grilles sur 24 h glissantes visible (abandons et grilles expirées compris), avec l'heure de la prochaine grille possible quand il est atteint. Une partie en cours est annoncée par un bandeau (niveau, début, **heure de fin**) avec « Reprendre » ou « Abandonner » ; le chrono continue page fermée. Une seule partie à la fois : pas de grille classée pendant un tournoi, ni l'inverse. Le résultat affiché ne dit jamais si le temps a été jugé trop rapide.
- **Second score** : grilles résolues par niveau (grilles classées et tournois), dans le salon, dans **Mon compte** et en colonnes du classement global (qui défile horizontalement dans son cadre sur téléphone, jamais la page).
- **Classement global** (accueil, menu ☰, salon) : top 10 par victoires et ta position, connecté seulement.
- Une manche = la même grille pour tous, un seul essai. La grille n'arrive qu'au démarrage ; le serveur mesure le temps et valide la grille. Le chrono affiché est indicatif et aucun temps n'est envoyé.
- Pas d'aides. Une grille fausse indique seulement le nombre d'essais restants, jamais les cases fausses.
- Classement par manche : rang, avatar, pseudo, temps, victoires ; « classement définitif » quand la manche est terminée.

Le jeu solo et ses codes de grille sont inchangés (les tests le vérifient grille par grille).

## Sécurité

- CSP stricte dans une balise `<meta>` : scripts, styles et polices uniquement depuis `/sudoku/`, aucun `unsafe-inline`, `connect-src` limité à l'API.
- Limites d'une CSP en `<meta>` (GitHub Pages ne permet pas d'envoyer d'en-têtes) : `frame-ancestors`, `report-uri`/`report-to` et `sandbox` y sont ignorés. Le mode tournoi refuse donc lui-même de s'ouvrir dans un cadre.
- Tout ce qui vient du serveur est affiché avec `textContent` (`tournoi.js` ne contient aucun `innerHTML`). Les messages d'erreur sont choisis côté front d'après le code d'erreur, jamais recopiés du serveur.
- Jeton de session dans `localStorage` sous la clé `sudoku-tournoi-token` (header `Authorization`, pas de cookie), jamais dans une URL ni dans la console. Toutes les pages de `lorenzoa93100.github.io` partagent ce stockage : n'y publier aucun autre site non maîtrisé.
- Connexion Discord : un `nonce` aléatoire (32 octets, `crypto.getRandomValues`) est gardé en `sessionStorage` (propre à l'onglet) et envoyé à l'API, qui construit elle-même l'URL Discord. L'aller vers Discord est une **navigation** (`location.assign`, seulement vers `https://discord.com/oauth2/authorize?…`), pas une requête : la CSP ne change pas. Au retour, le fragment `#login=…&state=…` est lu une fois puis effacé de l'adresse (`history.replaceState`) avant toute action ; `state` doit valoir le SHA-256 du nonce de cet onglet, sinon rien n'est envoyé. Le code (usage unique, 1 min) est échangé avec le nonce ; le nonce est effacé de `sessionStorage` dès le retour.
- Aucun secret dans ce dépôt.

## Configuration

L'adresse de l'API est écrite **à un seul endroit** : la directive `connect-src` de la CSP dans `index.html` (`https://jeu.taila17c77.ts.net`). `tournoi.js` la relit à partir de là. Si le dépôt change de nom, mettre à jour les chemins `/sudoku/` de la même CSP.

## Développement et tests

Le mode tournoi se développe contre un faux serveur d'API (`dev/fake-api.mjs`) qui imite la production, CORS de Caddy compris. Rien dans `dev/` n'est publié (`_config.yml`).

```sh
node --test --test-concurrency=1 "dev/*.test.mjs"   # tests de bout en bout (Node 22+, Playwright et Chromium installés)
node dev/serve.mjs                      # essai manuel : affiche la commande Chromium à lancer
```

Les tests chargent la page sous son vrai nom de domaine et parlent à l'API sous le sien, grâce à des serveurs HTTPS locaux et à une redirection DNS dans Chromium : la vraie CSP et le vrai CORS s'appliquent, sans rien relâcher côté serveur.
