# Sudoku

Jeu de sudoku avec aides expliquées, jouable dans le navigateur.

Tout tient dans un seul fichier : `index.html`.

## Personnalisation (Menu → Réglages)

- **Thèmes** : Auto, Clair, Sombre, Papier, Menthe, Lavande, Sakura, Contraste, Océan, Forêt, Minuit.
- **Couleur de tes chiffres** : couleurs prédéfinies (adaptées aux thèmes clairs et sombres) ou couleur perso.
- **Touche du mode crayon** : `N` par défaut, modifiable.

Les réglages, les stats et la partie en cours sont gardés dans le `localStorage` du navigateur.

## Codes de grille et partage

- Chaque grille a un **code** (ex. `E-7KQ2MXP`) : la lettre donne la difficulté, le reste est la seed. Le même code redonne toujours exactement la même grille.
- **Menu → Défier un ami** envoie le code et un lien `?g=CODE` qui ouvre directement cette grille.
- **Menu → Jouer avec un code** (ou « J'ai un code de grille » au choix de la difficulté) pour saisir un code reçu.
- En fin de partie, **Partager** envoie le temps, la difficulté, le code et une image de la grille terminée (sur mobile, via le menu de partage du téléphone ; sur ordinateur, le texte est copié et l'image peut être téléchargée).
