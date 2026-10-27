# Passerelle, version web avec Supabase

Ce dossier, c'est le jeu complet, prêt à mettre en ligne sur un site à toi, sans passer par Claude.
Supabase sert au mode en ligne, aux comptes partagés entre appareils et au classement.

Le jeu marche déjà sans rien configurer : entraînement, jeu à deux en local, compétition, tutoriel, et comptes gardés dans le navigateur.
Il te faut les étapes 1 à 5 pour avoir le mode en ligne. Comptes environ 15 minutes.

Les noms des menus de Supabase changent parfois un peu. Si tu ne trouves pas un bouton, cherche un mot proche.

## Contenu du dossier

| Fichier | À quoi il sert |
|---|---|
| `index.html` | Le jeu |
| `config.js` | **Le seul fichier à modifier** : l'adresse et la clé de ton projet Supabase |
| `supabase-adapter.js` | Relie le jeu à Supabase |
| `supabase.sql` | Crée la base de données et ses règles de sécurité, à coller une seule fois dans Supabase |
| `musique/` | Les musiques des univers |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | Permettent d'installer le jeu comme une appli sur téléphone ou ordi |

---

## 1. Créer le projet Supabase

1. Va sur **supabase.com** et clique sur **Start your project**. Inscris-toi, avec GitHub ou par e-mail.
2. Clique sur **New project** et remplis :
   - **Name** : `passerelle` ;
   - **Database password** : invente un mot de passe et garde-le quelque part (tu n'en auras pas besoin dans le jeu) ;
   - **Region** : une région en Europe, Paris ou Francfort par exemple.
3. Clique sur **Create new project**, puis attends 1 à 2 minutes.

## 2. Créer la base de données

1. Dans le menu de gauche, ouvre **SQL Editor** et clique sur **New query**.
2. Ouvre le fichier `supabase.sql` avec un éditeur de texte. Copie **tout** son contenu et colle-le dans Supabase.
3. Clique sur **Run**. Le message *Success. No rows returned* doit s'afficher.

## 3. Autoriser les joueurs sans inscription

Chaque joueur reçoit un identifiant automatique dès sa première visite, sans inscription.

1. Ouvre **Authentication** → **Sign In / Providers**. Dans les anciennes versions, c'est **Providers**.
2. Active **Allow anonymous sign-ins**, puis clique sur **Save**.

## 4. Mettre tes clés dans `config.js`

1. Ouvre **Project Settings** (la roue dentée).
2. Dans **Data API**, copie la **Project URL**. Elle ressemble à `https://abcdxyz.supabase.co`.
3. Dans **API Keys**, copie la clé **anon public** ou **publishable**. Elle se trouve parfois sous l'onglet *Legacy API keys*.
4. Ouvre `config.js` et remplace les deux valeurs :

```js
window.PASSERELLE_CONFIG = {
  supabaseUrl: 'https://abcdxyz.supabase.co',
  supabaseKey: 'eyJhbGciOi…',   // ou sb_publishable_…
  google: false,
};
```

> ⚠️ Utilise uniquement la clé **publique** (anon ou publishable).
> Ne mets **jamais** la clé `service_role` ou `secret` : elle donne tous les droits sur ta base.
> La clé publique peut être visible sans danger, parce que les règles de `supabase.sql` protègent les données.

## 5. Mettre le jeu en ligne

Le plus simple est **Netlify Drop**, gratuit :

1. Va sur **app.netlify.com/drop** et crée un compte gratuit.
2. **Glisse tout le dossier** `passerelle-web` dans la page.
3. Netlify te donne une adresse, par exemple `https://joyeux-lama-123.netlify.app`. Pour la changer, va dans **Site configuration** → **Change site name**, par exemple `passerelle-lucie`.

Ensuite, indique cette adresse à Supabase. C'est nécessaire pour que les liens de connexion reviennent vers ton site :

- Ouvre **Authentication** → **URL Configuration**.
- Dans **Site URL**, mets l'adresse de ton site.
- Dans **Redirect URLs**, ajoute la même adresse.

**C'est prêt.** Dans le jeu, choisis **En ligne** puis **Copier l'invitation**. L'invitation contient un lien du type `…/?partie=AB12C` : ton ami clique dessus et arrive directement dans la partie.

Autres hébergeurs possibles : GitHub Pages, Cloudflare Pages ou itch.io. Il suffit d'y envoyer les mêmes fichiers.

---

## 6. (Conseillé) Retrouver ses comptes sur un autre appareil

Dans **Mon compte**, un encadré propose : *« Ajoute ton e-mail pour retrouver tes comptes »*. Le joueur reçoit un code par e-mail, sans mot de passe.

Pour que ces e-mails partent vraiment, il faut deux réglages.

**a) Un service d'envoi d'e-mails.** Sans réglage, Supabase n'envoie des e-mails qu'aux membres de ton projet, et seulement quelques-uns par heure.
1. Crée un compte gratuit sur **resend.com** (3 000 e-mails par mois) et suis leurs instructions pour Supabase.
2. Dans Supabase, ouvre **Authentication** → **Emails** → **SMTP Settings**. Coche **Enable custom SMTP** et colle les réglages donnés par Resend.

**b) Le code dans les e-mails.** Dans **Authentication** → **Emails** → **Templates**, ajoute cette ligne aux modèles **Magic Link** et **Change Email Address** :

```
Ton code Passerelle : {{ .Token }}
```

Le code est important si le jeu est installé sur téléphone : le lien de l'e-mail s'ouvrirait dans le navigateur, pas dans l'appli.

## 7. (Facultatif) Connexion avec Google

1. Ouvre **Authentication** → **Sign In / Providers** → **Google** et suis le guide de Supabase. Il faut créer un identifiant OAuth sur console.cloud.google.com.
2. Active aussi **Allow manual linking** : sans ce réglage, un joueur anonyme perdrait ses comptes en se connectant avec Google.
3. Dans `config.js`, mets `google: true`, puis renvoie le dossier sur Netlify.

---

## Installer le jeu comme une appli

- **iPhone ou iPad** : ouvre le site dans Safari → bouton **Partager** → **Sur l'écran d'accueil**.
- **Android** : ouvre le site dans Chrome → menu **⋮** → **Installer l'application**.
- **Ordinateur** (Chrome ou Edge) : clique sur l'icône d'installation au bout de la barre d'adresse.

Une fois installé, le jeu s'ouvre en plein écran et marche même hors connexion. Seul le mode en ligne a besoin d'internet.

## Mettre à jour le jeu

Quand tu reçois une nouvelle version, remplace tous les fichiers **sauf `config.js`**, qui contient tes clés. Renvoie ensuite le dossier sur Netlify : glisse-le dans **Deploys** de ton site.

## En cas de souci

- **« Connexion au serveur de jeu impossible »** :
  - vérifie l'étape 3 (connexion anonyme activée) ;
  - vérifie les deux valeurs de `config.js` ;
  - ouvre la console du navigateur (F12) pour voir l'erreur exacte.
- **Le projet est « en pause »** : un projet gratuit se met en pause après une semaine sans aucune visite. Tu le relances d'un clic depuis le tableau de bord de Supabase.
- **Pas d'e-mail reçu** : refais l'étape 6a et regarde dans les spams.
- **Une partie n'apparaît pas en direct chez l'autre joueur** : le jeu revérifie toutes les 4 secondes de toute façon. Pour avoir le direct, vérifie que la fin de `supabase.sql` (la partie *Mises à jour en direct*) a bien été exécutée.
