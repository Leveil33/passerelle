# Guide : ouvrir les comptes Apple et Vercel (Phase 2)

Ce guide explique, pas à pas et sans jargon, ce que **toi** tu dois faire pour que les cartes arrivent
dans Apple Wallet. Je (Claude) ne peux pas le faire à ta place : cela passe par tes comptes personnels.
Aucun secret ne doit jamais être collé dans une conversation, un e-mail ou GitHub (le dépôt est public).

**Ordre conseillé :** lance l'étape 1 (Apple) tout de suite, car l'activation du compte peut prendre
plusieurs jours. Pendant l'attente, fais l'étape 2 (Vercel), qui est rapide.

---

## 1. Apple : compte, identifiant de carte et certificat

### 1.1 Créer le compte Apple Developer (99 $ par an)
1. Va sur https://developer.apple.com/programs/enroll et connecte-toi avec ton identifiant Apple
   (la double authentification doit être activée).
2. Choisis « Individuel » (la plus simple) ou « Organisation » (il faut alors un numéro D-U-N-S, plus long).
3. Paie les 99 $. **L'activation peut prendre de quelques heures à plusieurs jours.**

### 1.2 Noter ton « Team ID »
Une fois le compte actif : https://developer.apple.com/account → « Membership details » → copie le
**Team ID** (10 caractères, lettres et chiffres). Ce n'est pas un secret.

### 1.3 Créer le « Pass Type ID » (le nom de ton type de carte)
1. https://developer.apple.com/account/resources/identifiers/list → bouton « + ».
2. Choisis **Pass Type IDs**, puis « Continue ».
3. Description : « Carte de fidélité ». Identifiant : commence par `pass.` puis ton nom de domaine à
   l'envers, par exemple `pass.fr.monsite.fidelite`. Note-le : c'est la variable `APPLE_PASS_TYPE_ID`.

### 1.4 Créer le certificat de ce Pass Type ID
Apple te demande un fichier « CSR » (une demande de certificat). **La clé privée qui va avec ne doit
jamais quitter ton ordinateur.** Dans un terminal (Mac, Linux, ou « Git Bash » / WSL sous Windows) :

```bash
openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr -subj "/CN=Carte fidelite/emailAddress=ton@email.fr"
```

Cela crée `pass.key` (**secrète**, à garder précieusement) et `pass.csr`.
Puis, sur le site d'Apple : ouvre ton Pass Type ID → « Create Certificate » → envoie `pass.csr` →
télécharge le fichier `pass.cer`. Transforme-le en PEM :

```bash
openssl x509 -inform DER -in pass.cer -out pass.pem
```

### 1.5 Télécharger le certificat intermédiaire d'Apple (« WWDR »)
Sur https://www.apple.com/certificateauthority/ , télécharge le certificat **Worldwide Developer
Relations** indiqué comme valide (au moment d'écrire : « G4 »). **Dis-le-moi avant : je te confirmerai
lequel prendre, Apple en change de temps en temps.** Transforme-le en PEM :

```bash
openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem
```

### 1.6 Encoder les trois fichiers sur une seule ligne
Les réglages ne contiennent pas de fichiers : chaque certificat devient une longue ligne de texte.
- Mac : `base64 -i pass.pem | tr -d '\n'`
- Linux : `base64 -w0 pass.pem`
- Windows (PowerShell) : `[Convert]::ToBase64String([IO.File]::ReadAllBytes("pass.pem"))`

Fais pareil pour `pass.key` et `wwdr.pem`.

### 1.7 Variables à créer (réglages de l'environnement, jamais dans le chat)
| Variable | Valeur |
|---|---|
| `APPLE_PASS_TYPE_ID` | l'identifiant de l'étape 1.3 |
| `APPLE_TEAM_ID` | le Team ID de l'étape 1.2 |
| `APPLE_ORGANIZATION_NAME` | le nom affiché (ex. ton nom de marque) |
| `APPLE_SIGNER_CERT_BASE64` | `pass.pem` encodé (1.6) |
| `APPLE_SIGNER_KEY_BASE64` | `pass.key` encodé (1.6) — **secret** |
| `APPLE_WWDR_CERT_BASE64` | `wwdr.pem` encodé (1.6) |

> ⚠️ Le certificat d'un Pass Type ID a une durée de vie limitée (environ un an). À son expiration, plus
> aucune carte ne se met à jour : note la date de fin dans ton agenda.

---

## 2. Vercel : mettre le site en ligne en HTTPS

Apple exige une adresse **https** accessible depuis Internet pour mettre les cartes à jour : l'ordinateur
local ou cette session ne suffisent pas.

1. Crée un compte sur https://vercel.com (le plus simple : « Continue with GitHub »).
2. « Add New… → Project » → choisis le dépôt `Leveil33/passerelle`.
3. **Réglage important : « Root Directory » = `wallet-fidelite`.**
4. Ajoute les variables d'environnement (voir `.env.example`) : Supabase (3), `QR_HMAC_SECRET`,
   `NEXT_PUBLIC_APP_URL`, et celles d'Apple (1.7).
5. « Deploy ». Vercel te donne une adresse en `https://….vercel.app` : **elle suffit pour les essais.**
   Mets-la dans `NEXT_PUBLIC_APP_URL` (sans « / » final), puis redéploie.
6. Plus tard, un nom de domaine à toi (environ 10 € par an) donnera une adresse plus professionnelle.

> ⚠️ L'offre gratuite de Vercel (« Hobby ») est réservée à un usage non commercial : correct pour tes
> essais, mais il faudra l'offre payante pour de vrais commerçants.

---

## 3. Premier essai sur ton iPhone (je te guide)
1. Je crée un commerce de test et une carte de test (avec ton accord).
2. Tu ouvres le lien de la carte dans Safari sur ton iPhone et tu appuies sur « Ajouter ».
3. Je mets un tampon, je déclenche la mise à jour : la carte doit changer toute seule, avec une
   notification (« Plus que N tampons avant ta récompense ! »).

Pour l'étape 3, il faut aussi une variable `DEV_TOOLS_TOKEN` (une suite de 24 caractères au moins, au
hasard) : c'est le mot de passe de l'outil de test provisoire, supprimé en Phase 4.
