import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRateLimitStore } from '../../../common/rate-limit/memory-rate-limit-store';
import { LoginDelayService, loginIdentifierKey } from './login-delay.service';

const T0 = Date.parse('2026-10-06T08:00:00.000Z');
const SECOND = 1_000;

function setup() {
  const store = new MemoryRateLimitStore(() => T0);
  return { service: new LoginDelayService(store), store };
}

async function fail(service: LoginDelayService, times: number, at: number, slug = 'clinique', email = 'awa@test.sn') {
  for (let i = 0; i < times; i += 1) await service.recordFailure(slug, email, new Date(at));
}

describe('loginIdentifierKey', () => {
  it('est le sha256 de slug|email normalisés, préfixé pour ne pas entrer en collision avec le limiteur', () => {
    const digest = createHash('sha256').update('clinique|awa@test.sn').digest('hex');
    expect(loginIdentifierKey(' Clinique ', 'AWA@test.sn')).toBe(`login-delay:${digest}`);
  });
});

describe('LoginDelayService.retryAfterSeconds', () => {
  it('n’impose aucun délai avant le 5e échec', async () => {
    const { service } = setup();
    await fail(service, 4, T0);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(0);
  });

  it('impose 30 s après le 5e échec, décompté depuis le dernier échec', async () => {
    const { service } = setup();
    await fail(service, 5, T0);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(30);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0 + 10 * SECOND))).toBe(20);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0 + 30 * SECOND))).toBe(0);
  });

  it('arrondit la durée restante à la seconde supérieure', async () => {
    const { service } = setup();
    await fail(service, 5, T0);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0 + 29_500))).toBe(1);
  });

  it.each([
    [6, 60],
    [7, 120],
    [8, 300],
    [9, 600],
    [10, 900],
    [14, 900],
  ])('après %i échecs le délai est de %i s', async (failures, seconds) => {
    const { service } = setup();
    await fail(service, failures, T0);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(seconds);
  });

  it('oublie les échecs 24 h après le dernier', async () => {
    const { service } = setup();
    await fail(service, 10, T0);
    const dayLater = new Date(T0 + 24 * 3_600 * SECOND + SECOND);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', dayLater)).toBe(0);
    const record = await service.recordFailure('clinique', 'awa@test.sn', dayLater);
    expect(record.count).toBe(1);
  });

  it('suit chaque identifiant séparément (e-mail inexistant compris)', async () => {
    const { service } = setup();
    await fail(service, 5, T0, 'clinique', 'inconnu@test.sn');
    expect(await service.retryAfterSeconds('clinique', 'inconnu@test.sn', new Date(T0))).toBe(30);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(0);
    expect(await service.retryAfterSeconds('autre', 'inconnu@test.sn', new Date(T0))).toBe(0);
  });
});

describe('LoginDelayService.clear', () => {
  it('remet le compteur à zéro', async () => {
    const { service } = setup();
    await fail(service, 7, T0);
    await service.clear('clinique', 'awa@test.sn');
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(0);
  });
});

describe('LoginDelayService.claimSuspiciousAlert', () => {
  it('accorde l’alerte une seule fois par compte et par 24 h', async () => {
    const { service } = setup();
    expect(await service.claimSuspiciousAlert('t1', 'u1')).toBe(true);
    expect(await service.claimSuspiciousAlert('t1', 'u1')).toBe(false);
    expect(await service.claimSuspiciousAlert('t1', 'u2')).toBe(true);
  });
});

describe('LoginDelayService.admit (vérification et enregistrement atomiques)', () => {
  const trusted = () => Promise.resolve(true);
  const untrusted = () => Promise.resolve(false);

  it('admet la tentative et la compte aussitôt comme un échec', async () => {
    const { service } = setup();
    const first = await service.admit('clinique', 'awa@test.sn', new Date(T0));

    expect(first).toEqual({ allowed: true, retryAfterSeconds: 0, count: 1 });
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(0);
  });

  it('refuse pendant le délai sans compter le refus', async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i += 1) await service.admit('clinique', 'awa@test.sn', new Date(T0));

    const refused = await service.admit('clinique', 'awa@test.sn', new Date(T0 + 10 * SECOND));

    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 20, count: 5 });
  });

  it('plafonne le délai à 60 s depuis un réseau de confiance (décision 21)', async () => {
    const { service } = setup();
    await fail(service, 8, T0);

    expect(await service.admit('clinique', 'awa@test.sn', new Date(T0), trusted)).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(await service.admit('clinique', 'awa@test.sn', new Date(T0), untrusted)).toMatchObject({ allowed: false, retryAfterSeconds: 300 });
    expect((await service.admit('clinique', 'awa@test.sn', new Date(T0 + 61 * SECOND), trusted)).allowed).toBe(true);
  });

  it('n’évalue le réseau que si le délai dépasse le plafond', async () => {
    const { service } = setup();
    const probe = vi.fn(trusted);
    await fail(service, 5, T0);

    await service.admit('clinique', 'awa@test.sn', new Date(T0), probe);

    expect(probe).not.toHaveBeenCalled();
  });

  it('release retire la tentative réservée', async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i += 1) await service.admit('clinique', 'awa@test.sn', new Date(T0));

    await service.release('clinique', 'awa@test.sn');

    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(0);
  });
});

describe('LoginDelayService.claimDelayedAudit', () => {
  it('accorde un audit « connexion ralentie » au plus une fois par identifiant et par heure', async () => {
    const { service } = setup();
    const at = (ms: number) => new Date(T0 + ms);

    expect(await service.claimDelayedAudit('clinique', 'awa@test.sn', at(0))).toBe(true);
    expect(await service.claimDelayedAudit('Clinique', 'AWA@test.sn', at(SECOND))).toBe(false);
    expect(await service.claimDelayedAudit('clinique', 'awa@test.sn', at(3_599 * SECOND))).toBe(false);
    expect(await service.claimDelayedAudit('clinique', 'binta@test.sn', at(0))).toBe(true);
    expect(await service.claimDelayedAudit('clinique', 'awa@test.sn', at(3_600 * SECOND + 1))).toBe(true);
    expect(await service.claimDelayedAudit('clinique', 'awa@test.sn', at(3_700 * SECOND))).toBe(false);
  });
});
