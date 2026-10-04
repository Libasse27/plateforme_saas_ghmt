# 08 — Correctifs issus des revues (lot 1) et contrats modifiés

> Revues du 2026-10-04 : contrat web↔API, conformité santé, sécurité. Ce document est la spécification
> d'exécution du lot 1 ; le lot 2 (évolutions plus lourdes) est reporté dans `06-roadmap-mvp.md`.

## Contrats API modifiés (référence commune API ↔ Web)

### C1. Recherche patient : `POST /api/v1/patients/search` (permission `patients:patient:read`)
Corps JSON : `{ q?: string(2..100), phone?: E.164, ipp?: string /^P\d{2}-\d{7}$/, limit?: 1..100 (défaut 20), cursor?: string }`.
Au moins un critère parmi q / phone / ipp, sinon **422 `search_criteria_required`**. `GET /patients` est **supprimé** (aucun terme de recherche dans une URL).
Réponse : liste paginée (`meta.pagination`) de `{ id, ipp, firstName, lastName, sex, birthDate, birthDateEstimated, city }`.

### C2. Rendez-vous : forme `AppointmentView`
Ajout de `patient: { id, ipp, fullName, birthYear | null }` et `practitioner: { id, fullName, specialty | null }`.
`reason` et `cancelReason` ne sont présents **que** si l'appelant détient `consultations:consultation:read` (sinon champs absents).

### C3. Doublon patient : `POST /api/v1/patients`
409 `patient_duplicate` avec `details.candidates: [{ id, ipp, fullName, birthYear }]` (≤ 5).
Forçage : `POST /patients?force=true` **avec** `forceReason` (3..500 caractères) dans le corps JSON ; sinon 422 `force_reason_required`. Le forçage et son motif sont audités (motif sans donnée patient).

### C4. `GET /api/v1/auth/me`
`tenant: { id, slug, name, timezone, countryCode, baseCurrency }` + `user.mustChangePassword: boolean`.

### C5. Concurrence optimiste patients
`PATCH` et `DELETE /patients/:id` exigent `If-Match: "<rowVersion>"` : absent ⇒ **428 `precondition_required`**, périmé ⇒ 412 `precondition_failed`. `GET /patients/:id` renvoie `ETag`.
`DELETE /patients/:id` exige un corps `{ reason }` (3..500).

### C6. Invitations (remplace le mot de passe imposé par l'admin)
- `POST /api/v1/iam/users` : corps `{ fullName, email, locale?, roleAssignments[] }` **sans mot de passe**. Crée l'utilisateur au statut `invited` et envoie un email d'invitation (jeton 256 bits à usage unique, hash SHA-256 stocké, TTL 72 h). **Le jeton n'est jamais renvoyé dans la réponse API.**
- `POST /api/v1/iam/users/:id/invitation` : renvoie un nouvel email (invalide le précédent).
- `GET /api/v1/auth/invitations/:token` (public) : `{ email, fullName, tenantName }` ou 410 `invitation_expired`.
- `POST /api/v1/auth/invitations/:token/accept` (public, throttlé) : `{ password }` ⇒ statut `active`, 204.
- Jeton encodé `<tenantId>.<secret>` (même schéma que refresh/challenge).

### C7. Mot de passe
- `POST /api/v1/auth/password/change` (`@AuthenticatedOnly`) : `{ currentPassword, newPassword }` ⇒ 204, révoque les autres sessions.
- Tant que `mustChangePassword` est vrai, `PermissionGuard` refuse toute route `@RequirePermission` avec **403 `password_change_required`**.

### C8. Déconnexion et déverrouillage
- `POST /api/v1/auth/logout` accepte en plus `{ refreshToken }` en **@Public** : révoque la session de ce jeton (204 même si inconnu).
- `POST /api/v1/iam/users/:id/unlock` (`iam:user:update`) : remet `failedAttempts=0`, `lockedUntil=null`, audit.

### C9. Transmission de l'IP client par le BFF
Le BFF envoie `X-Forwarded-For: <ip client>` et `User-Agent` sur chaque appel API. L'API ne fait confiance qu'aux proxys listés dans `TRUSTED_PROXIES` (CIDR, défaut `loopback`). Le throttle de `login` et `mfa/verify` est aussi indexé sur `sha256(tenantSlug|email)`.

## Lot 1 — API (`apps/api`, `packages/shared`)
A1 C1 · A2/A3 C2 · A4 C3 (détection élargie : nom/prénom inversés, année ±2 si date estimée, `nationalIdBidx` ; extras `details` dans `DomainErrorExtras` ; `DomainError.preconditionFailed/preconditionRequired`) · A5 C5 (helper `common/http/if-match.ts`) · A6 périmètre patients (`scopesFor` sur `primarySiteId`, NULL visible par tous les détenteurs) + projection « identité seule » (sans téléphone/email/pièce/adresse déchiffrés) pour qui n'a pas `patients:patient:update` · A7 audit `patient.searched` avec `patientIds`, `appointment.listed`/`appointment.read` avec ids, chaîne d'audit : erreur si le maillon `seq-1` manque · A8 C4 via fonction SECURITY DEFINER `platform.current_tenant_profile()` (nouvelle migration) · A9 dates de naissance (≤ aujourd'hui, âge ≤ 130 ans, `birthDateEstimated` exige `birthDate`, PATCH de `birthDate` sans l'indicateur ⇒ false ; `null` accepté au PATCH pour phone, email, nationalId, address, city, bloodGroup) · A10 machine à états (no-show seulement après `startsAt`, check-in seulement le jour J dans le fuseau du tenant, suppression seulement en `scheduled`/`confirmed`, refus pour patient décédé ou créneau passé) · A11 rôles (retirer `appointments:appointment:delete` à receptionist et admin_agent ; director sans `appointments:*:read`) · A12 le filtre d'erreurs ne logue que `{ name, code, message tronqué à 200 }` · H1 C9 · H2 C6 + C7 (mailer SMTP `nodemailer`, Mailpit en dev, transport mémoire en test ; audit `iam.role.sensitive_assigned` quand un rôle clinique/financier est affecté) · M1 C8 unlock · M2 C8 logout · L1 à l'émission d'un jeton de grâce, révoquer le remplaçant non utilisé · L3 curseurs validés (`isUuid`) sinon 422 · L4 suppression de l'authentification par cookie dans `JwtAuthGuard` · L8 test d'intégration : toute table `tenant.*` a `relrowsecurity` et `relforcerowsecurity` et une colonne `tenant_id`.

## Lot 1 — Web (`apps/web`)
B1 recherche via Server Action → C1 (page patients et choix du patient dans la prise de RDV), aucun terme en URL, numéro local normalisé avec l'indicatif du `countryCode` du tenant · B2 agenda lit C2, n'appelle `/practitioners` que si `appointments:agenda:read`, ne charge plus la fiche complète pour un nom · B3 doublon C3 (candidats + « Créer quand même » avec motif) · B4 fuseau et nom d'établissement depuis C4, mention « date estimée », retrait de la colonne Téléphone vide · B5 messages 409 `invalid_transition`/`concurrent_update`/`duplicate`, mapping `startsAt/endsAt → time`, avertissement si `hasMore`, retrait de `requested` · C6 page publique `/invitation/[token]` (définir son mot de passe) · C7 page `/securite/mot-de-passe` + redirection si `mustChangePassword` · C8 la déconnexion envoie le refresh token · C9 transmission `X-Forwarded-For`/`User-Agent` · en-têtes `Strict-Transport-Security` (production) et `Referrer-Policy: no-referrer`.

## Infra (fait hors agents)
Ports Docker liés à `127.0.0.1`, images épinglées, mots de passe via variables d'environnement.

## Risque résiduel assumé (H2)
Un administrateur peut toujours inviter une adresse email qu'il contrôle : la technique ne peut empêcher un administrateur malveillant de créer un compte. La défense repose alors sur la détection : audit `iam.role.sensitive_assigned`, revue périodique des affectations par le Directeur, et (lot 2) notification au Directeur de toute affectation clinique ou financière.

## Re-revue — correctifs complémentaires
> Re-revue santé et sécurité du 2026-10-04 (API : `apps/api`, `packages/shared`). Chaque point a ses tests (unitaires et/ou e2e : `test/patients/patients-rerevue.e2e-spec.ts`, `test/appointments/appointments-rerevue.e2e-spec.ts`, `test/iam/users.e2e-spec.ts`, specs de domaine et du filtre d'erreurs).

1. **[HIGH] Audit du doublon** : le 409 `patient_duplicate` est audité (`patient.duplicate_detected` : `changes.patientIds` des candidats, `changes.criteria` = types de critères, jamais de valeurs) dans une transaction séparée validée avant la levée de l'erreur (l'exception n'annule plus la trace).
2. **[MOYEN] Doublon hors périmètre** : plus de `candidates: []` ; nouveau `409 patient_duplicate_out_of_scope` sans `details`, forçable (`?force=true` + `forceReason`), audité `patient.duplicate_out_of_scope` (outcome `success`, `patientIds` en audit seulement). Si au moins un homonyme est visible, 409 classique avec les seuls candidats visibles.
3. **[MOYEN] Projection par patient** : coordonnées déchiffrées si le patient est couvert par la portée de `patients:patient:update` (règle de `domain/patient-scope.ts` sur `primarySiteId`, `isPatientWithinScope`), plus de `grants.some(...)` sans portée.
4. **[MOYEN] Motif de RDV par ligne** : `reason`/`cancelReason` selon la portée de `consultations:consultation:read` appliquée au site du rendez-vous / service du praticien.
5. **[MOYEN] Périmètre patient à la prise de RDV** : `findPatient` applique le filtre `patients:patient:read`. Création : patient hors périmètre = `422 not_found` sur `patientId`, **identique** à un id inexistant (indiscernable ; un 404 aurait révélé l'existence). Reprogrammation du rendez-vous d'un patient hors périmètre : `404`.
6. **[MOYEN] Patient décédé** : `CARE_TRANSITIONS` ne contient plus `in_progress` ni `completed` (une consultation en cours se poursuit et se clôture) ; `confirmed` et `checked_in` restent refusés (`422 patient_deceased`).
7. **[FAIBLE] Détection** : candidat « nom seul » (l'une des fiches sans date) ; n° de pièce normalisé (`normalizeNationalId`) avant l'index aveugle à la création, la mise à jour et la détection. Les index aveugles de pièces déjà enregistrées avant ce correctif ne sont pas recalculés (pas de migration de données).
8. **[FAIBLE] Date de naissance** : schéma partagé ≤ aujourd'hui+1 jour UTC ; contrôle exact côté service avec le fuseau du tenant (`loadTenantProfile`, `Clock`) : `422` `birth_date_in_future` sur `birthDate` (création et PATCH).
9. **[FAIBLE] Fiche et noms** : `contactRedacted`, `deceasedAt` (fiche et `AppointmentView.patient`), `fullName` « Prénom NOM » (mappers patient et rendez-vous, candidats compris).
10. **[FAIBLE] Suppression d'un patient** : annulation des rendez-vous futurs non terminés dans la même transaction (`cancelReason: patient_record_deleted`) ; `patient.deleted` consigne `cancelledAppointmentIds`.
11. **[FAIBLE sécu] `enable`** : un utilisateur sans credential repasse en `invited` (l'invitation peut être renvoyée) ; audit `after.status` reflète le statut réel.
12. **[FAIBLE sécu] Filtre d'erreurs** : pour une erreur Prisma (nom `Prisma*` ou code `P\d{4}`), le journal ne contient que `name` et `code`, jamais le message.

Contrats modifiés utiles au web : codes `patient_duplicate_out_of_scope` (409) et `validation_failed`/`birth_date_in_future` ; champs `contactRedacted` (fiche), `deceasedAt` (`AppointmentView.patient`), `fullName` en « Prénom NOM » ; `reason`/`cancelReason` absents hors portée clinique.
