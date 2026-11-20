# Carte de fidélité Wallet

Cartes de fidélité à tampons dans **Apple Wallet** et **Google Wallet**, avec une appli web
installable (PWA) pour que les commerçants scannent les cartes de leurs clients.

> Le cahier des charges complet est dans [`CLAUDE.md`](./CLAUDE.md).
> Ce projet vit dans le dossier `wallet-fidelite/` du dépôt ; le reste du dépôt (le jeu Passerelle,
> publié par Netlify depuis `site/`) n'est pas concerné.

## Où on en est

| Phase | Contenu | État |
|---|---|---|
| 0 | Mise en place (Next.js, Supabase, Tailwind, `.env.example`) | ✅ fait, en attente de validation |
| 1 | Base de données et logique métier | à faire |
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

## Commandes utiles

| Commande | Rôle |
|---|---|
| `npm run dev` | Lance l'appli en local |
| `npm run build` | Construit la version de production (vérifie qu'il n'y a pas d'erreur) |
| `npm run lint` | Vérifie la qualité du code |

## Organisation du code

```
src/app/                 pages et routes API (Next.js, App Router)
src/app/api/health/      contrôle de la connexion Supabase
src/lib/supabase/        les 3 façons de parler à Supabase :
  client.ts                 depuis le navigateur (clé publique)
  server.ts                 depuis le serveur, au nom de l'utilisateur connecté (RLS active)
  admin.ts                  depuis le serveur, tous droits (clé secrète — serveur uniquement)
```

## Sécurité

- Aucune clé, aucun certificat dans le code ni dans Git : tout passe par les variables
  d'environnement (`.env.local` en local, réglages Vercel en ligne).
- `.env.example` est le seul fichier `.env` versionné ; il ne contient que des champs vides.
