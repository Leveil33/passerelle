# Passerelle — notes pour Claude

- Répondre en français. Ne pas proposer de version app Mac.
- Source unique : `jeu/passerelle.html` (HTML + CSS + JS dans un seul fichier, three.js r128). C'est aussi la page publiée sur claude.ai (https://claude.ai/artifact/TQJhsMNG9hfgD8XVKL4aDt, avec les musiques `site/musique/*.mp3` publiées sous `musique/`). Le code web n'agit que si `window.PASSERELLE_CONFIG` / `window.PASSERELLE_AUTH` existent ; sur claude.ai, le jeu passe par `window.claude.use('db'|'user'|'room')`.
- Après toute modification du jeu : `python3 web/make_web.py`, puis commit de `jeu/` **et** `site/` (Netlify publie `site/` sans étape de build).
- `web/supabase-adapter.js` imite l'API `claude.use` (db / user / room) avec Supabase : table `public.docs` (chemins `joueurs/<uid>`, `parties/<CODE>`), RPC `doc_merge`, Realtime (broadcast + presence + postgres_changes).
- Ne jamais écraser `site/config.js` (clés du projet Supabase `rxfxukkbmocnaccpakbn`).
- Tester avant de livrer (voir README) : `tests/comptes.js`, `tests/web-faux-serveur.js` ; `tests/web-vrai-serveur.js` écrit dans la vraie base (nettoyer ensuite les lignes de test).
- Attention : le jeu a sa propre variable `history` ; utiliser `window.history`.
- Compétition en ligne : parties `parties/<CODE>` avec `comp` (cadence), `ranked`, `e1/e2` (Elo au départ), `t` (ms passées) dans chaque coup, `flag` (camp tombé au temps) ; recherche d'adversaire = parties `mm: 'open'` avec battement `seen` (10 s). Elo dans le compte : `elo`, `rated`, `rw/rl/rd`, `eloPeak` (1200 au départ, K 40 puis 20 après 20 parties).
- Chaque adresse du site a sa propre mémoire de navigateur (donc son propre joueur anonyme) : `site/config.js` → `siteUrl` fixe l'adresse principale ; les liens de déploiement Netlify y sont toujours renvoyés.
