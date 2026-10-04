-- Extensions « trusted » requises (docs/02 §7.1)
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tenant";

-- CreateEnum
CREATE TYPE "platform"."establishment_type" AS ENUM ('hospital_n1', 'hospital_n2', 'hospital_n3', 'medicalized_center', 'health_center', 'clinic', 'private_practice', 'laboratory', 'pharmacy', 'diagnostic_center', 'specialized_center', 'other');

-- CreateEnum
CREATE TYPE "platform"."tenant_status" AS ENUM ('pending', 'active', 'suspended', 'terminated');

-- CreateEnum
CREATE TYPE "tenant"."scope_type" AS ENUM ('tenant', 'site', 'department');

-- CreateEnum
CREATE TYPE "tenant"."user_status" AS ENUM ('invited', 'active', 'locked', 'disabled');

-- CreateEnum
CREATE TYPE "tenant"."sex" AS ENUM ('male', 'female', 'other', 'unknown');

-- CreateEnum
CREATE TYPE "tenant"."appointment_status" AS ENUM ('requested', 'scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show');

-- CreateTable
CREATE TABLE "platform"."tenants" (
    "id" UUID NOT NULL,
    "group_id" UUID,
    "slug" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_name" TEXT,
    "establishment_type" "platform"."establishment_type" NOT NULL,
    "status" "platform"."tenant_status" NOT NULL DEFAULT 'pending',
    "country_code" CHAR(2) NOT NULL,
    "base_currency" CHAR(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Dakar',
    "default_locale" TEXT NOT NULL DEFAULT 'fr',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."modules" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_core" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "platform"."tenant_modules" (
    "tenant_id" UUID NOT NULL,
    "module_code" TEXT NOT NULL,
    "enabled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_modules_pkey" PRIMARY KEY ("tenant_id","module_code")
);

-- CreateTable
CREATE TABLE "platform"."permissions" (
    "code" TEXT NOT NULL,
    "module_code" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "tenant"."sites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "country_code" CHAR(2),
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "parent_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'clinical',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "full_name" TEXT NOT NULL,
    "status" "tenant"."user_status" NOT NULL DEFAULT 'invited',
    "locale" TEXT NOT NULL DEFAULT 'fr',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "users_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."user_credentials" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("tenant_id","user_id")
);

-- CreateTable
CREATE TABLE "tenant"."mfa_factors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'totp',
    "secret_enc" BYTEA NOT NULL,
    "last_used_step" BIGINT,
    "backup_code_hashes" TEXT[],
    "activated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."mfa_challenges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "device_label" TEXT,
    "user_agent" TEXT,
    "ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "template_code" TEXT,
    "mfa_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."role_permissions" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("tenant_id","role_id","permission_code")
);

-- CreateTable
CREATE TABLE "tenant"."user_role_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "tenant"."scope_type" NOT NULL,
    "scope_id" UUID,
    "valid_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_label" TEXT,
    "user_agent" TEXT,
    "ip" INET,
    "mfa_verified_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."refresh_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chain_seq" BIGINT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "delegated_grant_id" UUID,
    "session_id" UUID,
    "ip" INET,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" UUID,
    "patient_id" UUID,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "changes" JSONB,
    "request_id" TEXT,
    "prev_hash" BYTEA NOT NULL,
    "hash" BYTEA NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."sequence_counters" (
    "tenant_id" UUID NOT NULL,
    "scope_key" TEXT NOT NULL,
    "period_key" TEXT NOT NULL DEFAULT '',
    "last_value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sequence_counters_pkey" PRIMARY KEY ("tenant_id","scope_key","period_key")
);

-- CreateTable
CREATE TABLE "tenant"."patients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ipp" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "search_name" TEXT NOT NULL,
    "birth_date" DATE,
    "birth_date_estimated" BOOLEAN NOT NULL DEFAULT false,
    "sex" "tenant"."sex" NOT NULL DEFAULT 'unknown',
    "blood_group" TEXT,
    "national_id_enc" BYTEA,
    "national_id_bidx" BYTEA,
    "phone_enc" BYTEA,
    "phone_bidx" BYTEA,
    "email_enc" BYTEA,
    "email_bidx" BYTEA,
    "address_enc" BYTEA,
    "city" TEXT,
    "primary_site_id" UUID,
    "key_version" SMALLINT NOT NULL DEFAULT 1,
    "deceased_at" TIMESTAMPTZ(6),
    "merged_into_patient_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."practitioners" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "full_name" TEXT NOT NULL,
    "specialty" TEXT,
    "department_id" UUID,
    "primary_site_id" UUID,
    "license_number" TEXT,
    "default_consult_minutes" INTEGER NOT NULL DEFAULT 20,
    "is_bookable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "practitioners_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."appointments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "tenant"."appointment_status" NOT NULL DEFAULT 'scheduled',
    "source" TEXT NOT NULL DEFAULT 'front_desk',
    "reason" TEXT,
    "cancel_reason" TEXT,
    "checked_in_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "platform"."tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_group_id_idx" ON "platform"."tenants"("group_id");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "platform"."tenants"("status");

-- CreateIndex
CREATE INDEX "permissions_module_code_idx" ON "platform"."permissions"("module_code");

-- CreateIndex
CREATE UNIQUE INDEX "sites_tenant_id_code_key" ON "tenant"."sites"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "departments_tenant_id_site_id_idx" ON "tenant"."departments"("tenant_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_site_id_code_key" ON "tenant"."departments"("tenant_id", "site_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "tenant"."users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factors_tenant_id_user_id_kind_key" ON "tenant"."mfa_factors"("tenant_id", "user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenges_tenant_id_token_hash_key" ON "tenant"."mfa_challenges"("tenant_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_code_key" ON "tenant"."roles"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "role_permissions_tenant_id_permission_code_idx" ON "tenant"."role_permissions"("tenant_id", "permission_code");

-- CreateIndex
CREATE INDEX "user_role_assignments_tenant_id_user_id_idx" ON "tenant"."user_role_assignments"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "user_role_assignments_tenant_id_role_id_idx" ON "tenant"."user_role_assignments"("tenant_id", "role_id");

-- CreateIndex
CREATE INDEX "user_role_assignments_tenant_id_scope_type_scope_id_idx" ON "tenant"."user_role_assignments"("tenant_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_user_id_idx" ON "tenant"."sessions"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_expires_at_idx" ON "tenant"."sessions"("tenant_id", "expires_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_session_id_idx" ON "tenant"."refresh_tokens"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_family_id_idx" ON "tenant"."refresh_tokens"("tenant_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tenant_id_token_hash_key" ON "tenant"."refresh_tokens"("tenant_id", "token_hash");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "tenant"."audit_logs"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_resource_type_resource_id_occurred_at_idx" ON "tenant"."audit_logs"("tenant_id", "resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_actor_user_id_occurred_at_idx" ON "tenant"."audit_logs"("tenant_id", "actor_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_patient_id_occurred_at_idx" ON "tenant"."audit_logs"("tenant_id", "patient_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_tenant_id_chain_seq_key" ON "tenant"."audit_logs"("tenant_id", "chain_seq");

-- CreateIndex
CREATE INDEX "patients_tenant_id_birth_date_idx" ON "tenant"."patients"("tenant_id", "birth_date");

-- CreateIndex
CREATE INDEX "patients_tenant_id_phone_bidx_idx" ON "tenant"."patients"("tenant_id", "phone_bidx");

-- CreateIndex
CREATE INDEX "patients_tenant_id_national_id_bidx_idx" ON "tenant"."patients"("tenant_id", "national_id_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "patients_tenant_id_ipp_key" ON "tenant"."patients"("tenant_id", "ipp");

-- CreateIndex
CREATE INDEX "practitioners_tenant_id_department_id_idx" ON "tenant"."practitioners"("tenant_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "practitioners_tenant_id_user_id_key" ON "tenant"."practitioners"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_patient_id_starts_at_idx" ON "tenant"."appointments"("tenant_id", "patient_id", "starts_at" DESC);

-- CreateIndex
CREATE INDEX "appointments_tenant_id_practitioner_id_starts_at_idx" ON "tenant"."appointments"("tenant_id", "practitioner_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_site_id_starts_at_idx" ON "tenant"."appointments"("tenant_id", "site_id", "starts_at");

-- AddForeignKey
ALTER TABLE "platform"."tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."tenant_modules" ADD CONSTRAINT "tenant_modules_module_code_fkey" FOREIGN KEY ("module_code") REFERENCES "platform"."modules"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."permissions" ADD CONSTRAINT "permissions_module_code_fkey" FOREIGN KEY ("module_code") REFERENCES "platform"."modules"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."sites" ADD CONSTRAINT "sites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."departments" ADD CONSTRAINT "departments_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "tenant"."sites"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."user_credentials" ADD CONSTRAINT "user_credentials_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant"."users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."mfa_factors" ADD CONSTRAINT "mfa_factors_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant"."users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "tenant"."roles"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."role_permissions" ADD CONSTRAINT "role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "platform"."permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."user_role_assignments" ADD CONSTRAINT "user_role_assignments_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant"."users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."user_role_assignments" ADD CONSTRAINT "user_role_assignments_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "tenant"."roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."sessions" ADD CONSTRAINT "sessions_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant"."users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "tenant"."sessions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."patients" ADD CONSTRAINT "patients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."appointments" ADD CONSTRAINT "appointments_tenant_id_patient_id_fkey" FOREIGN KEY ("tenant_id", "patient_id") REFERENCES "tenant"."patients"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."appointments" ADD CONSTRAINT "appointments_tenant_id_practitioner_id_fkey" FOREIGN KEY ("tenant_id", "practitioner_id") REFERENCES "tenant"."practitioners"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."appointments" ADD CONSTRAINT "appointments_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "tenant"."sites"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
