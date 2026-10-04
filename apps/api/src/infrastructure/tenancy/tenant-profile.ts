import type { TenantProfile } from '@ghmt/shared';
import { DomainError } from '../../common/errors/domain-error';
import type { TenantTx } from '../prisma/tenant-db.service';

interface TenantProfileRow {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  country_code: string;
  base_currency: string;
}

/**
 * Profil de l'établissement courant via la fonction SECURITY DEFINER `platform.current_tenant_profile()`
 * (le tenant est lu dans le contexte RLS, jamais fourni par l'appelant).
 */
export async function loadTenantProfile(tx: TenantTx): Promise<TenantProfile> {
  const rows = await tx.$queryRaw<TenantProfileRow[]>`
    SELECT id::text AS id, slug, name, timezone, country_code::text AS country_code, base_currency::text AS base_currency
    FROM platform.current_tenant_profile()`;
  const row = rows[0];
  if (!row) throw DomainError.notFound('Établissement');
  return { id: row.id, slug: row.slug, name: row.name, timezone: row.timezone, countryCode: row.country_code, baseCurrency: row.base_currency };
}
