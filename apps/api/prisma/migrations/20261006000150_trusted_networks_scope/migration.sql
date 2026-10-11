BEGIN;

-- docs/11 décision 23 : plages de confiance d'au moins /24 (IPv4) et /48 (IPv6), comme le contrôle applicatif.
-- Une plage plus large déjà enregistrée (antérieure au contrôle) est retirée : elle ferait passer pour « réseau de
-- l'établissement » des adresses qui n'en sont pas. Le retrait est strictement plus prudent (MFA exigée hors réseau).
-- RLS FORCE suspendue le temps de cette mise à jour multi-tenant (rôle propriétaire), rétablie dans la même transaction.
ALTER TABLE tenant.trusted_networks NO FORCE ROW LEVEL SECURITY;
UPDATE tenant.trusted_networks
SET deleted_at = now()
WHERE deleted_at IS NULL AND masklen(network) < CASE family(network) WHEN 4 THEN 24 ELSE 48 END;
ALTER TABLE tenant.trusted_networks FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant.trusted_networks
  DROP CONSTRAINT ck_trusted_networks_prefix,
  ADD CONSTRAINT ck_trusted_networks_prefix
    CHECK (deleted_at IS NOT NULL OR masklen(network) >= CASE family(network) WHEN 4 THEN 24 ELSE 48 END);

-- docs/11 décision 26 : une plage vaut pour tout l'établissement ; le rattachement par site reviendra avec le lot multi-sites.
ALTER TABLE tenant.trusted_networks
  DROP CONSTRAINT fk_trusted_networks_site,
  DROP COLUMN site_id;

COMMIT;
