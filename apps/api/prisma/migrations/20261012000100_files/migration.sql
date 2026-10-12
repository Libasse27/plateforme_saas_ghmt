-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Documents du patient, équipe DOC (docs/13-phase-socle-production.md §3.1)
-- Table tenant.files : métadonnées des fichiers déposés ; les objets (chiffrés, D4) sont dans le stockage S3.
-- Exécutée par ghmt_migrator. Le DDL de la section 1 est issu de `prisma migrate diff` (files.prisma) ; le reste
-- (clés étrangères composites, CHECK, index partiel, RLS) est complété en SQL : aucune relation Prisma entre fichiers.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Types et table (prisma migrate diff) ─────────
-- CreateEnum
CREATE TYPE "tenant"."file_purpose" AS ENUM ('identity', 'insurance_card', 'administrative');

-- CreateEnum
CREATE TYPE "tenant"."file_status" AS ENUM ('pending', 'available', 'rejected', 'deleted');

-- CreateEnum
CREATE TYPE "tenant"."file_reject_reason" AS ENUM ('infected', 'type_not_allowed', 'active_content', 'scan_unavailable');

-- CreateTable
CREATE TABLE "tenant"."files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purpose" "tenant"."file_purpose" NOT NULL,
    "patient_id" UUID,
    "status" "tenant"."file_status" NOT NULL DEFAULT 'pending',
    "reject_reason" "tenant"."file_reject_reason",
    "object_key" TEXT NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "original_name" BYTEA NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "scan_attempts" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "files_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "files_object_key_key" ON "tenant"."files"("object_key");

-- CreateIndex
CREATE INDEX "files_tenant_id_status_idx" ON "tenant"."files"("tenant_id", "status");

-- ───────── 2. Clés étrangères (composites : (tenant_id, id) du socle) ─────────
ALTER TABLE tenant.files
  ADD CONSTRAINT fk_files_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id),
  ADD CONSTRAINT fk_files_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES tenant.patients (tenant_id, id),
  ADD CONSTRAINT fk_files_created_by FOREIGN KEY (tenant_id, created_by) REFERENCES tenant.users (tenant_id, id);

-- ───────── 3. Contraintes ─────────
-- Les trois usages actuels (documents administratifs du patient) exigent un patient ; P17 ajoutera ses propres usages.
ALTER TABLE tenant.files
  ADD CONSTRAINT ck_files_patient_required CHECK (patient_id IS NOT NULL OR purpose NOT IN ('identity', 'insurance_card', 'administrative')),
  ADD CONSTRAINT ck_files_reject_reason CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  ADD CONSTRAINT ck_files_deleted_at CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  ADD CONSTRAINT ck_files_size CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  ADD CONSTRAINT ck_files_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_files_scan_attempts CHECK (scan_attempts >= 0);

-- ───────── 4. Index ─────────
-- Liste des documents d'un patient (plus récents d'abord), seuls les fichiers disponibles.
CREATE INDEX ix_files_patient_available ON tenant.files (tenant_id, patient_id, created_at DESC) WHERE status = 'available';

-- ───────── 5. Isolation (même politique que 20261004000200) ─────────
ALTER TABLE tenant.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant.files;
CREATE POLICY tenant_isolation ON tenant.files AS PERMISSIVE FOR ALL
  USING (tenant_id = (SELECT tenant.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT tenant.current_tenant_id()));
-- ghmt_app : DML explicite (en plus des privilèges par défaut du schéma tenant) ; ghmt_platform n’a aucun accès.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.files TO ghmt_app;
REVOKE ALL ON tenant.files FROM ghmt_platform;
