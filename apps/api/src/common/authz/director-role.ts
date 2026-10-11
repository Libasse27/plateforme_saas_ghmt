/**
 * Critère unique du rôle « Directeur » (docs/11 D10) : rôle SYSTÈME cloné du modèle `director`. Un rôle personnalisé nommé
 * « director » ne compte pas. Utilisable tel quel comme filtre Prisma sur `role` ; le script `transfer-tenant-owner.mts`
 * en garde une copie SQL.
 */
export const DIRECTOR_ROLE = { isSystem: true, templateCode: 'director' } as const;

export function isDirectorRole(role: { readonly isSystem: boolean; readonly templateCode: string | null }): boolean {
  return role.isSystem === DIRECTOR_ROLE.isSystem && role.templateCode === DIRECTOR_ROLE.templateCode;
}
