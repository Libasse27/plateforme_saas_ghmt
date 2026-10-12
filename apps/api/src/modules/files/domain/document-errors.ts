import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error';
import type { LimitViolation } from '../../../common/authz/entitlement-rules';

/** Erreurs du contrat des documents (docs/13 §5). Aucun détail ne révèle l'existence d'une ressource d'un autre tenant. */
export const DocumentErrors = {
  patientNotFound: (): DomainError => new DomainError('patient_not_found', HttpStatus.NOT_FOUND, 'Not Found', 'Patient introuvable.'),
  /** Absent, d'un autre patient ou d'un autre tenant, ou non `available` (au téléchargement). */
  documentNotFound: (): DomainError => new DomainError('document_not_found', HttpStatus.NOT_FOUND, 'Not Found', 'Document introuvable.'),
  fileTooLarge: (): DomainError =>
    new DomainError('file_too_large', HttpStatus.PAYLOAD_TOO_LARGE, 'Payload Too Large', 'Fichier trop volumineux (10 Mo au plus).'),
  fileRequired: (): DomainError =>
    DomainError.validation([{ path: 'file', code: 'file_required', message: 'Un fichier non vide est obligatoire (champ « file »).' }]),
  typeNotAllowed: (): DomainError =>
    new DomainError(
      'type_not_allowed',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'Unsupported Media Type',
      'Type de fichier non accepté (PDF, JPEG, PNG, WebP).',
    ),
  activeContent: (): DomainError => DomainError.unprocessable('active_content', 'Le document contient du contenu actif (JavaScript) et a été refusé.'),
  /** Objet stocké altéré ou illisible (le tag d'authentification échoue) : rien n'est envoyé au client. */
  documentUnreadable: (): DomainError =>
    new DomainError('document_unreadable', HttpStatus.INTERNAL_SERVER_ERROR, 'Internal Server Error', 'Le document est illisible : son intégrité n’est pas vérifiée.'),
  infected: (): DomainError => DomainError.unprocessable('infected', 'Fichier refusé par l’analyse antivirus.'),
  storageUnavailable: (): DomainError =>
    new DomainError('storage_unavailable', HttpStatus.SERVICE_UNAVAILABLE, 'Service Unavailable', 'Le stockage des documents est momentanément indisponible.'),
  /** Même code et même forme que les autres limites du plan (`plan_limit_reached`, `{ limit, current }` en Go). */
  storageQuotaReached: (violation: LimitViolation): DomainError =>
    new DomainError('plan_limit_reached', HttpStatus.FORBIDDEN, 'Forbidden', 'L’espace de stockage de votre offre est atteint.', {
      details: { metric: 'storageGb', limit: violation.limit, current: violation.current },
    }),
} as const;
