-- ════════════════════════════════════════════════════════════════════════════
-- Consentement aux messages du commerçant (préparation : l'envoi viendra après la V1).
--
-- Une case à cocher DISTINCTE à l'inscription (jamais cochée d'avance) : « J'accepte de recevoir
-- des offres de ce commerçant sur ma carte ». Si le client la coche, on enregistre la date ;
-- sinon la valeur reste vide. Retirer son consentement = remettre la valeur à vide.
--
-- Indépendant de l'e-mail : on peut accepter les messages sans donner d'e-mail, et inversement.
-- Colonne visible du serveur uniquement (aucun droit de lecture pour les employés).
--
-- AJOUT UNIQUEMENT : aucune donnée existante n'est modifiée.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.customers add column marketing_consent_at timestamptz;

comment on column public.customers.marketing_consent_at is
  'Date à laquelle le client a coché la case « recevoir des offres du commerçant sur ma carte ». Vide = pas de consentement : aucun message commerçant ne doit être envoyé.';
