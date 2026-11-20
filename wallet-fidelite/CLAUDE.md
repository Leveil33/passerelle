# Projet : Carte de fidélité Wallet (Apple & Google) + appli de scan commerçant

> Ce document est le cahier des charges du projet. Lis-le en entier avant de coder.
> Travaille phase par phase (voir « Plan de réalisation »), et demande-moi validation à la fin de chaque phase.
> Langue de l'interface : **français**. Code et noms de variables : anglais.

---

## 1. Objectif

Créer une solution de carte de fidélité **dématérialisée** :

1. Le **client** ajoute une carte de fidélité à tampons dans **Apple Wallet** ou **Google Wallet**, sans installer d'application.
2. Le **commerçant** (ou son employé) scanne le QR code de la carte avec son téléphone via une **web app installable (PWA)** → un tampon est ajouté.
3. Quand toutes les cases sont remplies, le commerçant **valide la récompense** → la carte est **remise à 0** (le compteur de récompenses obtenues augmente).
4. À chaque changement, la carte se **met à jour automatiquement** dans le Wallet du client, avec une **notification**.
5. Quand le client passe **à proximité du commerce (~100 m)**, la carte s'affiche sur son écran verrouillé avec un message personnalisé (notification de proximité du Wallet).

La solution doit être **multi-commerces** dès le départ (plusieurs commerçants, chacun avec son programme, ses adresses et ses employés).

---

## 2. Contraintes techniques importantes (à respecter, ne pas « contourner »)

- **Notification de proximité** : ce n'est PAS une notification push qu'on déclenche nous-mêmes. On déclare des coordonnées GPS dans la carte et c'est le système qui affiche la carte sur l'écran verrouillé.
  - Apple : champ `locations` (max **10** adresses par carte), avec `relevantText` (message affiché) et `maxDistance` (en mètres, viser 100). Type de carte : `storeCard`. Affichage discret (sans son).
  - Google : champ `locations` sur l'objet / la classe (max **10**). Google choisit le rayon et n'affiche pas de texte personnalisé.
  - Si un commerçant a plus de 10 adresses : prévoir plus tard la mise à jour de la carte avec les 10 adresses les plus pertinentes (hors périmètre V1, mais ne pas bloquer cette évolution dans le modèle de données).
- **Vraies notifications** (avec son) : uniquement lors d'une **mise à jour de la carte**.
  - Apple : mise à jour via le *PassKit Web Service* + push APNs (payload vide, topic = `passTypeIdentifier`), puis le texte du champ modifié s'affiche grâce à `changeMessage` (ex. `"Plus que %@ tampons avant ta récompense !"`).
  - Google : `PATCH` de l'objet + `addMessage` avec `messageType: TEXT_AND_NOTIFY`. **Google limite le nombre de notifications par jour** → ne pas en envoyer à chaque modification mineure.
- Pas d'application native à publier sur les stores : l'appli commerçant est une **PWA**.

---

## 3. Stack technique

- **Framework** : Next.js (App Router) + TypeScript, déployé sur **Vercel**.
- **Base de données + authentification** : **Supabase** (Postgres + Auth + Row Level Security).
- **Cartes Apple** : librairie `passkit-generator` (signature du `.pkpass`).
- **Push Apple** : appel HTTP/2 direct à APNs (`api.push.apple.com`) avec le certificat Pass Type ID (ou la librairie `@parse/node-apn`).
- **Cartes Google** : Google Wallet API (REST) via `google-auth-library` + lien « Ajouter à Google Wallet » signé en JWT.
- **Scan QR dans la PWA** : `html5-qrcode` (ou `@zxing/browser`).
- **UI** : Tailwind CSS. Interface simple, gros boutons, pensée pour mobile.
- **Tests** : Vitest pour la logique métier.

Toutes les clés et certificats passent par des **variables d'environnement** (jamais dans le code ni dans Git). Fournir un fichier `.env.example` documenté.

---

## 4. Modèle de données (Supabase / Postgres)

```
merchants           id, name, logo_url, brand_color, created_at
merchant_users      id, merchant_id, user_id (auth.users), role ('owner' | 'staff')
loyalty_programs    id, merchant_id, name, stamps_required (int), reward_label (ex. "1 café offert"),
                    proximity_message (texte affiché à ~100 m), is_active
locations           id, merchant_id, label, address, latitude, longitude
customers           id, first_name, email (optionnel), created_at
cards               id, program_id, customer_id, serial_number (unique), auth_token (secret Apple),
                    stamps (int, défaut 0), rewards_earned (int, défaut 0),
                    platform ('apple' | 'google' | 'both'), google_object_id, updated_at
stamp_events        id, card_id, merchant_user_id, type ('stamp' | 'reward_redeemed' | 'correction'),
                    stamps_before, stamps_after, created_at
apple_registrations id, card_id, device_library_id, push_token, created_at
```

- Activer la **RLS** : un membre d'un commerce ne voit et ne modifie que les données de son commerce.
- Tout changement de tampons passe par une **fonction serveur unique** (ou une fonction Postgres) qui :
  1. vérifie les droits,
  2. met à jour `cards` dans une transaction,
  3. écrit une ligne dans `stamp_events`,
  4. déclenche la mise à jour Apple et/ou Google.

---

## 5. Parcours utilisateurs

### 5.1 Client – obtenir sa carte
1. Il scanne un QR code affiché en boutique (ou ouvre un lien) → page `/join/[programId]`.
2. Il saisit son prénom (email optionnel, avec case de consentement RGPD).
3. Il choisit **« Ajouter à Apple Wallet »** ou **« Ajouter à Google Wallet »** (détecter l'appareil et mettre le bon bouton en avant).
4. La carte affiche : logo, nom du commerce, prénom, tampons sous la forme `3 / 10`, récompense, QR code.

### 5.2 Commerçant – scanner
1. Connexion à la PWA (`/staff`) avec email + mot de passe (Supabase Auth).
2. Bouton **« Scanner une carte »** → caméra → lecture du QR.
3. Écran de résultat : prénom du client, tampons actuels, bouton **« + 1 tampon »** (gros, vert).
4. Si la carte est **pleine** : afficher **« Récompense disponible : 1 café offert »** + bouton **« Valider la récompense »** → tampons remis à 0, `rewards_earned + 1`.
5. Confirmation visuelle et vibration du téléphone (`navigator.vibrate`).
6. Bouton **« Annuler le dernier tampon »** disponible pendant 2 minutes (crée un événement `correction`).

### 5.3 Commerçant (propriétaire) – administration
- Modifier le programme : nombre de cases, récompense, message de proximité, couleurs, logo.
- Gérer les adresses (avec saisie de l'adresse → latitude / longitude ; un champ manuel suffit en V1).
- Inviter / retirer des employés.
- Tableau simple : nombre de cartes, tampons du jour, récompenses données.
- Toute modification du programme ou des adresses doit **mettre à jour les cartes existantes**.

---

## 6. Sécurité et anti-fraude

- Le QR code contient `serial_number` + une **signature HMAC** (clé secrète serveur). Le serveur refuse tout QR non signé ou modifié.
- Un employé ne peut scanner que les cartes **de son commerce**.
- **Anti double scan** : refuser un 2ᵉ tampon sur la même carte dans un délai configurable (défaut : 10 minutes), avec message clair.
- Endpoints Apple Web Service protégés par l'en-tête `Authorization: ApplePass <auth_token>`.
- Journaliser tous les événements (`stamp_events`).
- Limiter le nombre de requêtes sur les routes publiques (`/join`, endpoints Wallet).

---

## 7. Endpoints à implémenter

### Apple PassKit Web Service (obligatoires, chemins imposés par Apple)
```
POST   /api/apple/v1/devices/{deviceLibraryId}/registrations/{passTypeId}/{serial}   → enregistrer un appareil
DELETE /api/apple/v1/devices/{deviceLibraryId}/registrations/{passTypeId}/{serial}   → désinscrire
GET    /api/apple/v1/devices/{deviceLibraryId}/registrations/{passTypeId}?passesUpdatedSince=…  → cartes modifiées
GET    /api/apple/v1/passes/{passTypeId}/{serial}                                    → renvoyer le .pkpass à jour
POST   /api/apple/v1/log                                                             → logs Apple
```
Le `.pkpass` doit contenir `webServiceURL` et `authenticationToken`.

### Application
```
POST /api/cards                    → créer une carte (depuis /join)
GET  /api/cards/{serial}/apple     → télécharger le .pkpass
GET  /api/cards/{serial}/google    → rediriger vers le lien « Ajouter à Google Wallet »
POST /api/scan                     → (staff) lire un QR, renvoyer l'état de la carte
POST /api/cards/{id}/stamp         → (staff) +1 tampon
POST /api/cards/{id}/redeem        → (staff) valider la récompense et remettre à 0
POST /api/cards/{id}/undo          → (staff) annuler le dernier tampon
```

---

## 8. Plan de réalisation (une phase = une validation)

**Phase 0 – Mise en place**
- Projet Next.js, Supabase, Tailwind, `.env.example`, README avec les étapes d'installation.
- ✅ Critère : le projet démarre en local et se connecte à Supabase.

**Phase 1 – Base de données et logique métier**
- Tables, RLS, fonction d'ajout de tampon / de récompense / d'annulation.
- Tests unitaires : ajout de tampon, carte pleine, remise à 0, anti double scan, annulation.
- ✅ Critère : tous les tests passent.

**Phase 2 – Carte Apple Wallet**
- Génération du `.pkpass` (storeCard, QR signé, `locations`, `maxDistance`, `relevantText`, `changeMessage`).
- Endpoints du Web Service + push APNs.
- ✅ Critère : la carte s'ajoute sur un iPhone et se met à jour toute seule après un tampon.

**Phase 3 – Carte Google Wallet**
- Classe de fidélité (`loyaltyClass`) par programme, objet (`loyaltyObject`) par carte, lien JWT, `PATCH` + `addMessage`, `locations`.
- ✅ Critère : la carte s'ajoute sur un Android et se met à jour après un tampon.

**Phase 4 – PWA commerçant**
- Connexion, scan, +1 tampon, récompense, annulation, installation sur l'écran d'accueil (manifest + service worker).
- ✅ Critère : parcours complet testé sur téléphone.

**Phase 5 – Administration**
- Programme, adresses, employés, statistiques simples, mise à jour des cartes existantes.

**Phase 6 – Finitions et mise en ligne**
- Page `/join` soignée, mentions RGPD, gestion des erreurs, déploiement Vercel, guide de test sur place (proximité).

---

## 9. Ce que je dois fournir (actions manuelles hors code)

Préviens-moi au bon moment et explique-moi chaque étape simplement :

- [ ] Compte **Apple Developer** (99 $/an) → créer un **Pass Type ID** + télécharger le certificat (.p12) + certificat WWDR d'Apple.
- [ ] Compte **Google Wallet API** (Google Pay & Wallet Console) → ID émetteur + compte de service Google Cloud (clé JSON).
- [ ] Projet **Supabase** (URL + clés).
- [ ] Compte **Vercel** et nom de domaine (HTTPS obligatoire pour Apple).
- [ ] Logo et couleurs du premier commerce test, et ses adresses.
- [ ] Un iPhone et un Android pour tester.

---

## 10. Hors périmètre V1 (à ne pas coder maintenant)

- Paiement / abonnement des commerçants.
- Plus de 10 adresses par carte.
- Campagnes de messages marketing envoyées à tous les clients.
- Application native iOS / Android.

---

## 11. Règles de travail

- Explique chaque choix important en français simple : je ne suis pas développeuse.
- Avant toute commande qui supprime des données ou modifie la base en production, demande-moi.
- Fais des commits clairs à chaque étape terminée.
- Si une contrainte Apple ou Google empêche de faire quelque chose comme décrit ici, dis-le-moi clairement au lieu de trouver une solution bancale.

---

## 12. Décisions prises en cours de projet (ajoutées après le cahier des charges initial)

- **Base de données partagée avec le jeu** : les tables du Wallet sont dans le projet Supabase du jeu
  Passerelle (`rxfxukkbmocnaccpakbn`). Règle de travail : changements **additifs uniquement**, on ne
  touche jamais à `public.docs` ni à ce qui sert au jeu. Les joueurs du jeu sont des utilisateurs
  anonymes (rôle `authenticated`) : toute règle de sécurité du Wallet repose donc sur
  l'appartenance à un commerce (`merchant_users`), jamais sur « être connecté ».
- **Personnalisation par le commerçant** : nom, couleur, logo, **tampon** (choisi dans une
  bibliothèque d'icônes, ou image importée), cases, récompense, message de proximité, délai anti
  double scan. Pas de mise en page ni de polices personnalisées en V1. La couleur du texte est
  calculée automatiquement (lisibilité).
- **Tampon** : colonnes `loyalty_programs.stamp_icon` (nom d'icône de la bibliothèque, ou `custom`) et
  `stamp_icon_url` (image importée). La « case vide » est la même icône estompée, générée
  automatiquement. Le bandeau est dessiné par le serveur à chaque état de la carte (Apple : image
  `strip` dans le `.pkpass` ; Google : `heroImage`, adresse publique https versionnée).
- **Images posées uniquement par le serveur** (logo et tampon importé) : le commerçant envoie un
  FICHIER (jamais une adresse), le serveur le contrôle (vrai format, taille), le redimensionne, le range
  dans notre stockage, puis écrit lui-même l'adresse. Raison : notre serveur télécharge ces images pour
  fabriquer les cartes, une adresse libre permettrait de lui faire télécharger n'importe quoi (SSRF).
  `merchants.logo_url` et `loyalty_programs.stamp_icon_url` n'ont aucun droit d'écriture pour
  `authenticated`.
- **Création de commerces** : côté serveur uniquement (pas d'inscription libre en V1).
