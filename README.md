# Passerelle

Jeu de stratégie à deux, en 3D : traverse le plateau avant ton adversaire.

**Jouer : https://passerelle-game.netlify.app/**

- Adresse unique : https://passerelle-game.netlify.app (`siteUrl` dans `site/config.js`).
- En local à deux, contre un bot (entraînement), en compétition, ou **en ligne**, chacun sur son appareil.
- Compétition en ligne : recherche d'adversaire automatique ou défi à un ami, pendule partagée, **classement Elo** dans le jeu.
- Comptes personnalisables (plusieurs par personne), classement, emotes, météo, plusieurs univers.
- Installable comme une appli sur téléphone ou ordinateur, et jouable hors connexion (sauf le mode en ligne).

## Comment c'est rangé

| Dossier | Contenu |
|---|---|
| `jeu/passerelle.html` | **La source du jeu**, en un seul fichier. On fait les modifications ici. |
| `site/` | Le site publié par Netlify. Il est fabriqué à partir de `jeu/`, sauf `config.js` et `musique/`. |
| `web/` | Ce qui fait du jeu un site autonome : lien avec Supabase, appli installable, icônes, et le script `make_web.py`. |
| `supabase/schema.sql` | La base de données du mode en ligne : tables et règles de sécurité. |
| `tests/` | Tests automatiques : comptes, mode en ligne avec un faux serveur ou le vrai, site en ligne. |
| `vendor/` | three.js en local, pour les tests. |

## Mettre à jour le site

1. Modifier `jeu/passerelle.html`.
2. Regénérer le site : `python3 web/make_web.py`.
3. Envoyer sur GitHub. Netlify publie automatiquement le dossier `site/` : voir `netlify.toml`.

## Tests

```bash
python3 -m http.server 8765 &                 # depuis la racine du dépôt
python3 tests/build.py                        # jeu + outils de test → tests/index.html
node tests/comptes.js                         # comptes, multi-comptes, classement

# mode en ligne avec un faux Supabase
SRC=tests/index.html python3 web/make_web.py tests/web
printf "window.PASSERELLE_CONFIG = { supabaseUrl: 'https://test.supabase.co', supabaseKey: 'cle-test' };\n" > tests/web/config.js
node tests/web-faux-serveur.js
node tests/competition.js                     # recherche d'adversaire, pendule partagée, Elo, classement
node tests/connexion.js                       # retrouver son compte par e-mail sur un nouvel appareil
```

Ces tests ont besoin de Node et de Playwright, avec Chromium.

## Services

- **Hébergement** : Netlify, projet `passerelle-game`.
- **Mode en ligne** : Supabase, projet `rxfxukkbmocnaccpakbn`. La clé dans `site/config.js` est la clé *publique* : ce sont les règles de `supabase/schema.sql` qui protègent les données.
- `web/LISEZMOI.md` explique comment tout réinstaller depuis zéro.

Musiques : compositeurs sous licence libre (crédits dans le jeu). Polices : Google Fonts.
