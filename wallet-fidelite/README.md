# Carte de fidélité Wallet

Cartes de fidélité à tampons dans **Apple Wallet** et **Google Wallet**, avec une appli web
installable (PWA) pour que les commerçants scannent les cartes de leurs clients.

> Le cahier des charges complet est dans [`CLAUDE.md`](./CLAUDE.md).
> Ce projet vit dans le dossier `wallet-fidelite/` du dépôt ; le reste du dépôt (le jeu Passerelle,
> publié par Netlify depuis `site/`) n'est pas concerné.

## Où on en est

| Phase | Contenu | État |
|---|---|---|
| 0 | Mise en place (Next.js, Supabase, Tailwind, `.env.example`) | ✅ fait (connexion vérifiée ; test de la clé secrète à refaire une fois la variable ajoutée) |
| 1 | Base de données et logique métier | ✅ fait, en attente de validation |
| 2 | Carte Apple Wallet | à faire |
| 3 | Carte Google Wallet | à faire |
| 4 | PWA commerçant | à faire |
| 5 | Administration | à faire |
| 6 | Finitions et mise en ligne | à faire |

## Installation en local

Il te faut **Node.js 20 ou plus récent** (https://nodejs.org, version « LTS »).

### 1. Créer le projet Supabase

1. Va sur https://supabase.com, crée un compte puis clique sur **New project**.
2. Donne-lui un nom (ex. `fidelite`), choisis une région proche de tes clients
   (ex. *West EU – Paris* ou *Frankfurt*) et note le mot de passe de la base quelque part de sûr.
3. Une fois le projet prêt, ouvre **Project Settings → API Keys** (ou *Data API*) et repère :
   - l'**adresse du projet** (`https://xxxx.supabase.co`) ;
   - la **clé publique** (*Publishable key*, ou *anon public* sur un ancien projet) ;
   - la **clé secrète** (*Secret key*, ou *service_role* sur un ancien projet).
   La clé secrète donne tous les droits : ne la colle jamais dans un message, un e-mail ou dans le code.

### 2. Configurer l'appli

```bash
cd wallet-fidelite
npm install
cp .env.example .env.local
```

Ouvre `.env.local` et colle les trois valeurs Supabase (adresse, clé publique, clé secrète).

### 3. Lancer

```bash
npm run dev
```

Ouvre http://localhost:3000 : la page affiche trois ✅ si la connexion à Supabase fonctionne,
ou un ❌ avec l'explication de ce qui manque. Le même contrôle est disponible en
http://localhost:3000/api/health (réponse en JSON, aucun secret affiché).

## Base de données (Phase 1)

Les tables du Wallet sont dans le **même projet Supabase que le jeu Passerelle** (décision du
projet). Elles sont strictement ajoutées à côté : la table du jeu (`public.docs`) n'est pas touchée.

Tout est décrit dans `supabase/migrations/` (`…_loyalty_schema.sql`, puis `…_stamp_icons.sql`) :

| Table | Rôle |
|---|---|
| `merchants`, `merchant_users` | commerces, et leurs membres (`owner` ou `staff`) |
| `loyalty_programs` | programme : cases, récompense, message de proximité, délai anti double scan, tampon (`stamp_icon`, `stamp_icon_url`) |
| `locations` | adresses du commerce (latitude / longitude) |
| `customers`, `cards` | clients et leurs cartes (numéro de série, secret Apple, tampons) |
| `stamp_events` | journal de tous les changements de tampons |
| `apple_registrations` | appareils Apple qui suivent une carte (serveur uniquement) |

**Les tampons ne changent que par trois fonctions** : `stamp_card`, `redeem_reward`,
`undo_last_stamp`. Chacune vérifie les droits, verrouille la carte, met à jour et écrit le journal
en une seule transaction. Personne (même propriétaire) ne peut écrire directement dans `cards`
ou `stamp_events`. Les employés ne peuvent lire ni le `auth_token` Apple ni l'e-mail des clients.

**Personnalisation** : le propriétaire d'un commerce peut changer son nom, sa couleur, les cases, la
récompense, le message de proximité et **choisir son tampon** (bibliothèque d'icônes, ou image
importée). Le **logo** et l'**image de tampon importée** ne s'écrivent jamais directement : le commerçant
envoie un fichier, le serveur le contrôle et le range, puis écrit lui-même l'adresse (sinon notre
serveur pourrait être poussé à télécharger n'importe quelle adresse). L'écran de modification et
l'import sont prévus en Phase 5 ; le dessin du bandeau de tampons en Phases 2 (Apple) et 3 (Google).

Refus renvoyés par ces fonctions (traduits en français dans `src/lib/loyalty/errors.ts`) :
`card_not_found`, `program_inactive`, `card_full`, `card_not_full`, `double_scan` (avec les
secondes restantes), `nothing_to_undo`, `undo_expired`, `not_authenticated`.

Pour recréer la base sur un nouveau projet Supabase : copier le contenu des fichiers de migration,
dans l'ordre, dans *SQL Editor → New query → Run* (une seule fois chacun).

## Tests

```bash
npm test
```

- `tests/db/` : les tests rejouent **le vrai fichier de migration** sur une base Postgres embarquée
  (PGlite, en mémoire — aucune clé ni connexion nécessaire) : tampon, carte pleine, remise à 0,
  anti double scan, annulation, et les règles de sécurité (qui peut voir ou faire quoi).
- `src/lib/loyalty/` : signature des QR codes (HMAC) et messages d'erreur.

Limites connues : PGlite est un Postgres 18, Supabase est en 17 ; et la protection contre deux
téléphones qui tamponnent exactement en même temps repose sur le verrou de ligne (`for update`),
qui n'est pas testé sous charge.

## Commandes utiles

| Commande | Rôle |
|---|---|
| `npm run dev` | Lance l'appli en local |
| `npm run build` | Construit la version de production (vérifie qu'il n'y a pas d'erreur) |
| `npm run lint` | Vérifie la qualité du code |
| `npm test` | Lance les tests |

## Organisation du code

```
src/app/                 pages et routes API (Next.js, App Router)
src/app/api/health/      contrôle de la connexion Supabase
src/lib/loyalty/         signature des QR codes (HMAC) et messages d'erreur des tampons
supabase/migrations/     le SQL de la base (tables, sécurité, fonctions de tampon)
tests/db/                tests de la base et de sa sécurité
src/lib/supabase/        les 3 façons de parler à Supabase :
  client.ts                 depuis le navigateur (clé publique)
  server.ts                 depuis le serveur, au nom de l'utilisateur connecté (RLS active)
  admin.ts                  depuis le serveur, tous droits (clé secrète — serveur uniquement)
```

## Sécurité

- Aucune clé, aucun certificat dans le code ni dans Git : tout passe par les variables
  d'environnement (`.env.local` en local, réglages Vercel en ligne).
- `.env.example` est le seul fichier `.env` versionné ; il ne contient que des champs vides.
