/* Page « Confidentialité » : applique seulement le thème choisi dans le jeu (réglage local).
   Aucun appel réseau, aucun innerHTML, aucune donnée lue en dehors du thème. */
(() => {
  "use strict";
  const THEMES = ["light", "dark", "papier", "menthe", "lavande", "sakura", "contraste", "ocean", "foret", "minuit"];
  let theme = null;
  try { theme = (JSON.parse(localStorage.getItem("sdk-settings") || "{}") || {}).theme; } catch (e) { theme = null; }
  if (THEMES.includes(theme)) document.documentElement.dataset.theme = theme;
})();
