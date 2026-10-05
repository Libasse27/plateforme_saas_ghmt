import { describe, expect, it } from 'vitest';
import { classifyHttpStatus, classifyNetworkError, classifySmtpError } from './error-classification';
import { maskEmail, maskPhone, deriveRecipientKey, recipientHash } from './masking';
import { backoffMs, decideAfterFailure, RETRY_POLICY } from './retry-policy';
import { isStopMessage } from './stop-keyword';

const ID = '0197a3c0-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-07T10:00:00Z');

describe('backoffMs', () => {
  it('SMS : 30 s × 2^(n-1) à ±10 % près', () => {
    for (const [attempt, base] of [[1, 30_000], [2, 60_000], [3, 120_000], [4, 240_000]] as const) {
      const delay = backoffMs('sms', attempt, ID);
      expect(delay).toBeGreaterThanOrEqual(base * 0.9);
      expect(delay).toBeLessThanOrEqual(base * 1.1);
    }
  });

  it('e-mail : 60 s × 2^(n-1), plafonné à 6 h', () => {
    expect(backoffMs('email', 1, ID)).toBeLessThanOrEqual(66_000);
    expect(backoffMs('email', 12, ID)).toBeLessThanOrEqual(6 * 3_600_000 * 1.1);
    expect(backoffMs('email', 12, ID)).toBeGreaterThanOrEqual(6 * 3_600_000 * 0.9);
  });

  it('est déterministe pour une même (notification, tentative) et varie selon la notification', () => {
    expect(backoffMs('sms', 2, ID)).toBe(backoffMs('sms', 2, ID));
    const delays = new Set(Array.from({ length: 20 }, (_, i) => backoffMs('sms', 2, `id-${i}`)));
    expect(delays.size).toBeGreaterThan(10);
  });
});

describe('decideAfterFailure (erreur transitoire)', () => {
  it('programme un nouvel essai tant que le nombre maximal et l’échéance ne sont pas atteints', () => {
    const decision = decideAfterFailure({ channel: 'sms', attempts: 1, now: NOW, deadlineAt: new Date(NOW.getTime() + 2 * 3_600_000), seed: ID });

    expect(decision.kind).toBe('retry');
    if (decision.kind === 'retry') expect(decision.nextAttemptAt.getTime()).toBe(NOW.getTime() + backoffMs('sms', 1, ID));
  });

  it('échoue en max_attempts après 5 tentatives SMS et 6 tentatives e-mail', () => {
    expect(RETRY_POLICY.sms.maxAttempts).toBe(5);
    expect(RETRY_POLICY.email.maxAttempts).toBe(6);
    expect(decideAfterFailure({ channel: 'sms', attempts: 5, now: NOW, deadlineAt: null, seed: ID })).toEqual({ kind: 'fail', errorCode: 'max_attempts' });
    expect(decideAfterFailure({ channel: 'email', attempts: 5, now: NOW, deadlineAt: null, seed: ID }).kind).toBe('retry');
    expect(decideAfterFailure({ channel: 'email', attempts: 6, now: NOW, deadlineAt: null, seed: ID })).toEqual({ kind: 'fail', errorCode: 'max_attempts' });
  });

  it('échoue en deadline_exceeded quand le prochain essai dépasse l’échéance', () => {
    const decision = decideAfterFailure({ channel: 'sms', attempts: 2, now: NOW, deadlineAt: new Date(NOW.getTime() + 10_000), seed: ID });

    expect(decision).toEqual({ kind: 'fail', errorCode: 'deadline_exceeded' });
  });

  it('l’in-app n’a qu’une tentative', () => {
    expect(decideAfterFailure({ channel: 'inapp', attempts: 1, now: NOW, deadlineAt: null, seed: ID })).toEqual({ kind: 'fail', errorCode: 'max_attempts' });
  });
});

describe('classifySmtpError', () => {
  it('classe les codes SMTP 4xx comme transitoires et 5xx comme destinataire permanent', () => {
    expect(classifySmtpError({ responseCode: 451 })).toEqual({ errorClass: 'transient', errorCode: 'smtp_451' });
    expect(classifySmtpError({ responseCode: 550 })).toEqual({ errorClass: 'permanent_recipient', errorCode: 'smtp_550' });
  });

  it('classe les erreurs réseau comme transitoires', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ESOCKET', 'ECONNECTION']) {
      expect(classifySmtpError({ code })).toEqual({ errorClass: 'transient', errorCode: code });
    }
  });

  it('classe une erreur inconnue comme transitoire (rejouable) sans exposer son message', () => {
    expect(classifySmtpError(new Error('adresse secrète awa@exemple.sn'))).toEqual({ errorClass: 'transient', errorCode: 'smtp_unknown' });
    expect(classifySmtpError(undefined)).toEqual({ errorClass: 'transient', errorCode: 'smtp_unknown' });
  });
});

describe('classifyHttpStatus (adaptateur SMS http)', () => {
  it.each([
    [200, null],
    [201, null],
    [400, { errorClass: 'permanent_recipient', errorCode: 'http_400' }],
    [404, { errorClass: 'permanent_recipient', errorCode: 'http_404' }],
    [422, { errorClass: 'permanent_recipient', errorCode: 'http_422' }],
    [401, { errorClass: 'permanent_config', errorCode: 'http_401' }],
    [402, { errorClass: 'permanent_config', errorCode: 'http_402' }],
    [403, { errorClass: 'permanent_config', errorCode: 'http_403' }],
    [408, { errorClass: 'transient', errorCode: 'http_408' }],
    [429, { errorClass: 'transient', errorCode: 'http_429' }],
    [500, { errorClass: 'transient', errorCode: 'http_500' }],
    [503, { errorClass: 'transient', errorCode: 'http_503' }],
  ])('statut %i', (status, expected) => {
    expect(classifyHttpStatus(status)).toEqual(expected);
  });

  it('un statut inattendu (3xx, 418) est transitoire', () => {
    expect(classifyHttpStatus(302)).toEqual({ errorClass: 'transient', errorCode: 'http_302' });
    expect(classifyHttpStatus(418)).toEqual({ errorClass: 'transient', errorCode: 'http_418' });
  });
});

describe('classifyNetworkError', () => {
  it('distingue le délai dépassé des autres erreurs réseau, toujours transitoires', () => {
    expect(classifyNetworkError({ name: 'TimeoutError' })).toEqual({ errorClass: 'transient', errorCode: 'timeout' });
    expect(classifyNetworkError({ name: 'AbortError' })).toEqual({ errorClass: 'transient', errorCode: 'timeout' });
    expect(classifyNetworkError(new Error('fetch failed'))).toEqual({ errorClass: 'transient', errorCode: 'network_error' });
  });
});

describe('maskPhone', () => {
  it('conserve l’indicatif et le début du numéro, masque le milieu et garde les deux derniers chiffres', () => {
    expect(maskPhone('+221771234545')).toBe('+22177*****45');
    expect(maskPhone('+237670000012')).toBe('+23767*****12');
  });

  it('masque aussi un numéro court', () => {
    const masked = maskPhone('+1234567');

    expect(masked).toContain('*');
    expect(masked).not.toBe('+1234567');
  });
});

describe('maskEmail', () => {
  it('masque la partie locale et le domaine en gardant l’initiale et le suffixe', () => {
    expect(maskEmail('awa@exemple.sn')).toBe('a***@e***.sn');
    expect(maskEmail('Awa.Diop@mail.clinique.com')).toBe('A***@m***.com');
  });

  it('gère une adresse sans point dans le domaine', () => {
    expect(maskEmail('a@localhost')).toBe('a***@l***');
  });
});

describe('recipientHash', () => {
  const key = deriveRecipientKey(Buffer.alloc(32, 7).toString('base64'));

  it('est un HMAC-SHA-256 stable de 32 octets, indépendant de la casse et des espaces', () => {
    const hash = recipientHash(key, '+221 77 123 45 45');

    expect(hash).toHaveLength(32);
    expect(hash.equals(recipientHash(key, '+221771234545'))).toBe(true);
    expect(recipientHash(key, 'Awa@Exemple.sn').equals(recipientHash(key, 'awa@exemple.sn'))).toBe(true);
  });

  it('diffère selon l’adresse et selon la clé maîtresse', () => {
    const other = deriveRecipientKey(Buffer.alloc(32, 8).toString('base64'));

    expect(recipientHash(key, '+221771234545').equals(recipientHash(key, '+221771234546'))).toBe(false);
    expect(recipientHash(key, '+221771234545').equals(recipientHash(other, '+221771234545'))).toBe(false);
  });

  it('ne contient jamais le clair', () => {
    expect(recipientHash(key, '+221771234545').toString('latin1')).not.toContain('221771234545');
  });
});

describe('isStopMessage', () => {
  it.each(['STOP', 'stop', ' Stop ', 'STOP.', 'Stop!', 'ARRET', 'arrêt', 'Arrêt.', 'STOP svp', 'stop tout', 'ArRêT '])('reconnaît « %s »', (text) => {
    expect(isStopMessage(text)).toBe(true);
  });

  it.each(['', 'OUI', 'STOPPER', 'ne pas stop', 'ARRET svp', 'nonstop', 'STO P', 'arreter'])('ignore « %s »', (text) => {
    expect(isStopMessage(text)).toBe(false);
  });
});
