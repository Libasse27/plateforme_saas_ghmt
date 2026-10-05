/** Briques de validation communes (sans dépendance vers ./index, pour éviter les cycles d'évaluation ESM). */
import { z } from 'zod';

export const uuid = z.uuid();
export const email = z.email().max(254).transform((v) => v.toLowerCase());
export const phoneE164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'téléphone au format E.164, ex. +221771234567');
export const isoDate = z.iso.date();
export const isoDateTime = z.iso.datetime({ offset: true });
/** Identifiant d'établissement (slug) : minuscules, chiffres et tirets, 3 à 48 caractères. */
export const tenantSlug = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug: minuscules, chiffres et tirets');
