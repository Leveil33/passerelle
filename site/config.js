// Réglages de ta version de Passerelle.
// Colle ici l'adresse et la clé publique de ton projet Supabase (Project Settings → API Keys / Data API).
// La clé « anon » (ou « publishable ») est faite pour être visible dans un site : ce sont les règles
// du fichier supabase.sql qui protègent les données. Ne mets JAMAIS ici la clé « service_role » ou « secret ».
// Tant que ces valeurs ne sont pas remplies, le jeu marche quand même, sans le mode en ligne.
window.PASSERELLE_CONFIG = {
  supabaseUrl: 'https://rxfxukkbmocnaccpakbn.supabase.co',
  supabaseKey: 'sb_publishable_wQd5y3KC7bY6WRDnj_AMkA_NAb4Sf5M',
  google: false,
  // Adresse principale du jeu : toute autre adresse *.netlify.app y renvoie (chaque adresse a sa propre mémoire,
  // donc son propre joueur). Laisser vide tant que le projet Netlify relié à GitHub n'a pas ce nom.
  siteUrl: '', // passe à true une fois Google activé dans Supabase (Authentication → Sign In / Providers)
};
