/**
 * Règles de mot de passe partagées (NIST 800-63B : longueur, pas de règles de composition, docs/04 §1.3).
 * Fichier sans dépendance vers ./index : importable par les schémas de module sans cycle.
 */
import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;
export const PRIVILEGED_PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
