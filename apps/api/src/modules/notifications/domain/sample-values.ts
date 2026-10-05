/** Valeurs d'exemple de longueur maximale, pour l'aperçu et le contrôle des longueurs (docs/10 §5.4). */
export const SAMPLE_VALUES: Readonly<Record<string, string>> = {
  'etablissement.nom': 'Clinique Internationale de Dakar',
  'site.nom': 'Site principal de la Corniche Ouest',
  'patient.prenom': 'Marie-Madeleine',
  'rdv.date': 'mercredi 30 septembre',
  'rdv.heure': '23:59',
  'facture.numero': 'GHMT-SN-2026-000123',
  'facture.montant': '1 000 000 000 XOF',
  'facture.echeance': '30 septembre 2026',
  'facture.jours_retard': '60',
  'quota.pourcentage': '100',
  'quota.limite': '20000',
  lien: 'https://app.ghmt.example.com/abonnement/factures',
};
