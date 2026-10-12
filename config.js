// Réglages de synchronisation (Supabase).
// Laisse vide pour utiliser l'appli sans synchronisation (données sur cet appareil uniquement).
// La clé « publishable » est une clé publique prévue pour être dans une appli : elle ne donne accès
// qu'aux données de la personne connectée, grâce aux règles de sécurité de la table.
// Ne mets JAMAIS ici une clé « secret » ou « service_role ».
window.CARNET_CONFIG = {
  supabaseUrl: "https://fxnlboaaexiucpjgadpw.supabase.co",
  supabaseAnonKey: "sb_publishable_BsyNao1AxQzHo0OjMhFslQ_AId9NTCq",
};
