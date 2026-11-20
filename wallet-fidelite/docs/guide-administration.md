# Guide : l'administration (Phase 5)

## Pour le commerçant propriétaire

1. Il se connecte sur `https://ton-site/staff/login` avec l'e-mail et le **mot de passe provisoire** que tu lui as transmis.
2. L'appli lui demande de **choisir son propre mot de passe** (10 caractères minimum). Rien d'autre ne s'ouvre avant.
3. Sur l'accueil : **Réglages de mon commerce**. Il peut :
   - voir les chiffres (cartes, tampons, récompenses) ;
   - changer le nom du programme, le nombre de cases, la récompense, le message de proximité, le délai anti double scan ;
   - choisir la **couleur**, un **tampon** parmi 16 ou **importer le sien**, importer son **logo** ;
   - ajouter ou supprimer ses **adresses** (latitude / longitude ; seules les 10 premières déclenchent l'affichage sur l'écran verrouillé) ;
   - **ajouter un employé** : un mot de passe provisoire s'affiche **une seule fois** (à lui transmettre) ; l'employé ne peut que scanner.
4. Chaque modification met à jour **toutes les cartes déjà installées** chez les clients, toute seule.

## Pour toi (propriétaire de la solution)

**Première fois : te donner l'accès à la page `/admin`.**
1. Supabase → Authentication → Users → Add user → Create new user (ton e-mail, un mot de passe, **coche « Auto Confirm User »**).
2. Dis-moi l'e-mail : avec ton accord, j'ajoute ce compte à la table `platform_admins` par une requête sur la base.
3. Ouvre `https://ton-site/admin` : formulaire **Créer un commerce** (nom + e-mail du propriétaire). Le compte est créé, un mot de passe
   provisoire s'affiche **une fois** : transmets-le au commerçant par un canal de ton choix.

Aucun e-mail n'est envoyé par l'appli (le service d'e-mail de Supabase n'est donc pas nécessaire).

## Limites à connaître
- Une carte (un programme) par commerce en V1 ; les réglages portent sur le premier commerce de l'utilisateur.
- Pas de suppression de logo (on le remplace).
- Au-delà de 2000 cartes, la mise à jour automatique est plafonnée par modification.
- Non vérifié ici : le rendu sur de vrais iPhone / Android et l'envoi réel des mises à jour (comptes Apple / Google requis).
