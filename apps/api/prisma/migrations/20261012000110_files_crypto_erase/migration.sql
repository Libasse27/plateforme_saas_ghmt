BEGIN;

-- GHMT — Effacement cryptographique des documents supprimés (docs/13 D4 et §5, revue DOC).
-- La clé de données enveloppée est détruite à la suppression : l'objet éventuellement resté dans le stockage (échec de
-- suppression, sauvegarde du bucket) devient définitivement indéchiffrable. La colonne devient donc nullable, et la base
-- impose qu'un fichier `deleted` n'ait plus de clé.
ALTER TABLE tenant.files ALTER COLUMN wrapped_key DROP NOT NULL;

-- Lignes déjà supprimées : clé détruite. RLS FORCE suspendue le temps de cette mise à jour multi-tenant (rôle propriétaire),
-- rétablie dans la même transaction.
ALTER TABLE tenant.files NO FORCE ROW LEVEL SECURITY;
UPDATE tenant.files SET wrapped_key = NULL WHERE status = 'deleted';
ALTER TABLE tenant.files FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant.files
  ADD CONSTRAINT ck_files_crypto_erase CHECK (status <> 'deleted' OR wrapped_key IS NULL);

COMMIT;
