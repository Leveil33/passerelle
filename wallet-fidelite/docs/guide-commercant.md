# Guide : l'appli du commerçant (Phase 4)

## Pour le commerçant (et ses employés)

**Ouvrir l'appli :** `https://ton-site/staff` dans le navigateur du téléphone.
**L'installer comme une vraie appli :**
- Android (Chrome) : menu ⋮ → « Installer l'application » (ou « Ajouter à l'écran d'accueil »).
- iPhone (Safari) : bouton Partager → « Sur l'écran d'accueil ».

**Se connecter :** e-mail et mot de passe fournis par le responsable de la solution. On reste connecté.

**Au comptoir :**
1. « Scanner une carte » → pointer la caméra vers le QR code affiché dans le Wallet du client (la première fois, accepter l'accès à la caméra).
2. L'écran montre le prénom et les tampons (par exemple 3 / 10). Appuyer sur le gros bouton vert **+ 1 tampon** ; le téléphone vibre.
3. Si la carte est pleine : **Valider la récompense** (la carte repart à 0).
4. Une erreur ? **Annuler le dernier tampon**, possible pendant 2 minutes.
5. « Scanner une autre carte » pour le client suivant.

**Bon à savoir :** il faut internet (Wi-Fi ou données mobiles). Une même carte ne peut pas être tamponnée deux fois de suite
avant le délai prévu par le programme (10 minutes par défaut). Si la caméra ne marche pas, il y a un champ pour saisir le code.

---

## Pour toi : créer un compte de test (en attendant la page d'administration de la Phase 5)

1. Supabase → **Authentication → Users → Add user → Create new user** : saisis un e-mail et un mot de passe,
   et **coche « Auto Confirm User »**. (Le mot de passe reste entre toi et la personne : ne me le donne pas.)
2. Dis-moi l'e-mail du compte créé. Je crée le commerce de test et je rattache ce compte à son commerce
   (avec ton accord, par une requête sur la base).
3. Sur un téléphone, ouvre `/staff` et connecte-toi.

> Pour que la connexion par e-mail fonctionne, le fournisseur « Email » doit être activé dans Supabase
> (*Authentication → Sign In / Providers*), ce qui est le cas par défaut.
> Sur Vercel, les variables `NEXT_PUBLIC_…` doivent exister **avant** le déploiement : elles sont figées dans l'appli à la construction.
