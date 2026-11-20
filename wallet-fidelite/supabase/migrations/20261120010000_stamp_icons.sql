-- ════════════════════════════════════════════════════════════════════════════
-- Tampon personnalisable (choisi dans une bibliothèque, ou importé par le commerçant)
-- + images posées uniquement par le serveur.
--
-- AJOUTS / RESTRICTIONS UNIQUEMENT : aucune donnée n'est supprimée ni modifiée.
--
-- Pourquoi « uniquement par le serveur » : pour fabriquer les cartes, NOTRE serveur télécharge
-- ces images. Si un commerçant pouvait écrire n'importe quelle adresse, il pourrait nous faire
-- télécharger un fichier énorme ou une adresse interne. Le commerçant envoie donc un FICHIER ;
-- le serveur le contrôle (vrai format d'image, taille), le redimensionne, le range dans notre
-- stockage, puis écrit lui-même l'adresse ci-dessous.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.loyalty_programs
  -- Tampon choisi : le nom d'une icône de la bibliothèque (ex. 'coffee', 'star'),
  -- ou 'custom' pour utiliser l'image importée (stamp_icon_url).
  add column stamp_icon text not null default 'star'
    check (stamp_icon ~ '^[a-z0-9-]{1,40}$'),
  -- Image importée (déjà contrôlée et redimensionnée) : posée par le serveur uniquement.
  add column stamp_icon_url text
    check (stamp_icon_url is null or stamp_icon_url ~ '^https://'),
  add constraint loyalty_programs_custom_stamp_has_image
    check (stamp_icon <> 'custom' or stamp_icon_url is not null);

-- Le propriétaire choisit l'icône ; il ne peut PAS écrire stamp_icon_url (aucun droit de colonne).
grant insert (stamp_icon) on public.loyalty_programs to authenticated;
grant update (stamp_icon) on public.loyalty_programs to authenticated;

-- Même règle pour le logo : plus d'écriture directe par le propriétaire (le serveur le pose
-- après l'envoi d'un fichier contrôlé). Nom et couleur restent modifiables par le propriétaire.
revoke update (logo_url) on public.merchants from authenticated;
