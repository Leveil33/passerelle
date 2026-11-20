# Guide : ouvrir les comptes Google pour Google Wallet (Phase 3)

Ce que **toi** tu dois faire pour que les cartes arrivent dans Google Wallet (Android). Aucun secret ne doit
jamais être collé dans une conversation, un e-mail ou GitHub (le dépôt est public). Il n'y a pas de frais
d'inscription chez Google pour Google Wallet.

**Ordre conseillé :** les étapes 1 à 4 sont rapides (environ 30 minutes). L'étape 6 (autorisation de
publication) dépend de Google et peut prendre du temps : fais-la dès que les essais fonctionnent.

---

## 1. Console Google Pay & Wallet : ton compte « émetteur »
1. Va sur https://pay.google.com/business/console et connecte-toi avec ton compte Google.
2. Crée ton **profil professionnel** (nom de l'entreprise, pays, coordonnées).
3. Ouvre « Google Wallet API » : la console t'attribue un **ID émetteur** (« Issuer ID », un long nombre).
   Note-le : c'est la variable `GOOGLE_WALLET_ISSUER_ID` (ce n'est pas un secret).

## 2. Google Cloud : le « compte de service » (le robot qui parle à Google pour nous)
1. Va sur https://console.cloud.google.com , crée un projet (ex. « fidelite-wallet »).
2. « APIs & Services → Library » : cherche **Google Wallet API** et clique sur « Enable ».
3. « IAM & Admin → Service Accounts → Create service account » : nom « wallet-fidelite », sans rôle particulier.
4. Ouvre ce compte de service → onglet « Keys » → « Add key → Create new key → **JSON** ».
   Un fichier `.json` est téléchargé : **c'est un secret, garde-le précieusement, ne le partage jamais.**

## 3. Autoriser le robot dans la console Wallet
Dans la console Wallet (étape 1) : « Users » → invite l'adresse e-mail du compte de service
(champ `client_email` du fichier JSON, elle se termine par `.iam.gserviceaccount.com`) avec le niveau
d'accès **Developer**.

## 4. Variables à créer (réglages de l'environnement, jamais dans le chat)
| Variable | Où la trouver |
|---|---|
| `GOOGLE_WALLET_ISSUER_ID` | l'ID émetteur de l'étape 1 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | champ `client_email` du fichier JSON |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | champ `private_key` du fichier JSON (garde les `\n` tels quels) — **secret** |

Il faut aussi `NEXT_PUBLIC_APP_URL` et `QR_HMAC_SECRET` (voir le guide Apple / Vercel : mêmes réglages).

## 5. Comptes de test
Tant que Google n'a pas accordé la publication, **seuls les comptes testeurs** peuvent ajouter une carte, et
elle porte la mention « TEST ONLY ». Dans la console Wallet : « Google Wallet API → Test accounts » → ajoute
l'adresse Gmail du téléphone Android de test (ton compte de développeur fonctionne aussi).

## 6. Demander l'accès à la publication
Quand les essais sont concluants : console Wallet → demande d'accès à la publication (« Request publishing
access »). Il faut avoir complété le **profil professionnel** et avoir créé au moins une classe (notre
première carte de test en crée une). Google examine la demande puis les classes de cartes ; la mention « TEST
ONLY » disparaît quand tout est approuvé. **Les délais dépendent de Google.**

---

## Premier essai sur ton Android (je te guide)
1. Je crée un commerce de test et une carte de test (avec ton accord).
2. Tu ouvres le lien de la carte sur ton Android (connecté avec un compte testeur) : « Ajouter à Google Wallet ».
3. Je mets un tampon et je déclenche la mise à jour : la carte doit changer d'elle-même, avec une notification
   « Plus que N tampons avant ta récompense ! ».

Pour déclencher la mise à jour à la main pendant les essais, on utilise l'outil de test provisoire
(`DEV_TOOLS_TOKEN`, voir le guide Apple / Vercel).

## À savoir
- **Notifications :** Google accepte au maximum 3 messages avec notification par 24 h et par carte. Notre
  serveur en envoie au plus 2 pour des tampons ordinaires et garde la 3e pour « récompense disponible ». Les
  autres changements mettent la carte à jour sans notification.
- **Proximité :** Google décide lui-même de la distance et du texte affiché près d'une adresse (on ne peut pas
  les personnaliser, contrairement à Apple).
