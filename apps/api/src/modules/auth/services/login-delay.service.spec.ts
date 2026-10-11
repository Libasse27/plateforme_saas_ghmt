import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRateLimitStore } from '../../../common/rate-limit/memory-rate-limit-store';
import { LoginDelayService, loginIdentifierKey, type LoginContext } from './login-delay.service';

const T0 = Date.parse('2026-10-06T08:00:00.000Z');
const SECOND = 1_000;

function setup() {
  const store = new MemoryRateLimitStore(() => T0);
  return { service: new LoginDelayService(store), store };
}

/** Amorce `times` échecs datés de `at` directement dans le stockage (barème nul : aucune tentative refusée). */
async function fail(store: MemoryRateLimitStore, times: number, at: number, slug = 'clinique', email = 'awa@test.sn') {
  for (let i = 0; i < times; i += 1) await store.gate(loginIdentifierKey(slug, email), 24 * 3_600 * SECOND, at, [0], null);
}

describe('loginIdentifierKey', () => {
  it('est le sha256 de slug|email normalisés, préfixé pour ne pas entrer en collision avec le limiteur', () => {
    const digest = createHash('sha256').update('clinique|awa@test.sn').digest('hex');
    expect(loginIdentifierKey(' Clinique ', 'AWA@test.sn')).toBe(`login-delay:${digest}`);
  });
});

describe('LoginDelayService.retryAfterSeconds', () => {
  it('n’impose aucun délai avant le 5e échec', async () => {
    const { service, store } = setup();
    await fail(store, 4, T0);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(0);
  });

  it('impose 30 s après le 5e échec, décompté depuis le dernier échec', async () => {
    const { service, store } = setup();
    await fail(store, 5, T0);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(30);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0 + 10 * SECOND))).toBe(20);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0 + 30 * SECOND))).toBe(0);
  });

  it('arrondit la durée restante à la seconde supérieure', async () => {
    const { service, store } = setup();
    await fail(store, 5, T0);
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
    const { service, store } = setup();
    await fail(store, failures, T0);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(seconds);
  });

  it('oublie les échecs 24 h après le dernier', async () => {
    const { service, store } = setup();
    await fail(store, 10, T0);
    const dayLater = new Date(T0 + 24 * 3_600 * SECOND + SECOND);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', dayLater)).toBe(0);
    expect(await service.admit('clinique', 'awa@test.sn', dayLater)).toMatchObject({ allowed: true, count: 1 });
  });

  it('suit chaque identifiant séparément (e-mail inexistant compris)', async () => {
    const { service, store } = setup();
    await fail(store, 5, T0, 'clinique', 'inconnu@test.sn');
    expect(await service.retryAfterSeconds('clinique', 'inconnu@test.sn', new Date(T0))).toBe(30);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(0);
    expect(await service.retryAfterSeconds('autre', 'inconnu@test.sn', new Date(T0))).toBe(0);
  });
});

describe('LoginDelayService.clear', () => {
  it('remet le compteur à zéro', async () => {
    const { service, store } = setup();
    await fail(store, 7, T0);
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
  const ACCOUNT_KEY = loginIdentifierKey('clinique', 'awa@test.sn');
  const context = (overrides: Partial<LoginContext> = {}) => () =>
    Promise.resolve<LoginContext>({ ip: '41.82.10.9', trustedNetwork: false, knownIp: false, ...overrides });

  it('admet la tentative et la compte aussitôt comme un échec', async () => {
    const { service } = setup();
    const first = await service.admit('clinique', 'awa@test.sn', new Date(T0));

    expect(first).toEqual({ allowed: true, retryAfterSeconds: 0, count: 1, key: ACCOUNT_KEY });
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(0);
  });

  it('refuse pendant le délai sans compter le refus', async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i += 1) await service.admit('clinique', 'awa@test.sn', new Date(T0));

    const refused = await service.admit('clinique', 'awa@test.sn', new Date(T0 + 10 * SECOND));

    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 20, count: 5, key: ACCOUNT_KEY });
  });

  it('décision 25 : depuis un réseau de confiance ou une IP connue, les échecs venus d’ailleurs ne retardent pas', async () => {
    const { service, store } = setup();
    await fail(store, 8, T0);

    const trusted = await service.admit('clinique', 'awa@test.sn', new Date(T0), context({ trustedNetwork: true }));
    const known = await service.admit('clinique', 'awa@test.sn', new Date(T0), context({ ip: '154.124.5.20', knownIp: true }));
    const elsewhere = await service.admit('clinique', 'awa@test.sn', new Date(T0), context());

    expect(trusted).toMatchObject({ allowed: true, count: 1 });
    expect(trusted.key).not.toBe(ACCOUNT_KEY);
    expect(known).toMatchObject({ allowed: true, count: 1 });
    expect(known.key).not.toBe(trusted.key);
    expect(elsewhere).toEqual({ allowed: false, retryAfterSeconds: 300, count: 8, key: ACCOUNT_KEY });
  });

  it('décision 25 : une IPv6 connue partage son compteur avec tout son /64', async () => {
    const { service, store } = setup();
    await fail(store, 8, T0);
    const a = await service.admit('clinique', 'awa@test.sn', new Date(T0), context({ ip: '2001:db8:1:2::10', knownIp: true }));
    const b = await service.admit('clinique', 'awa@test.sn', new Date(T0), context({ ip: '2001:db8:1:2:ffff::1', knownIp: true }));
    expect(b.key).toBe(a.key);
    expect(b.count).toBe(2);
  });

  it('décision 25 : le compteur compte + IP suit le barème, plafonné à 60 s sur réseau de confiance (décision 21)', async () => {
    const { service, store } = setup();
    await fail(store, 8, T0);
    const trusted = context({ trustedNetwork: true });
    // Sept échecs espacés depuis le réseau de l'établissement : le palier atteint (120 s) dépasse le plafond.
    for (let i = 0; i < 7; i += 1) await service.admit('clinique', 'awa@test.sn', new Date(T0 + i * 1_000 * SECOND), trusted);
    const last = T0 + 6 * 1_000 * SECOND;

    expect(await service.admit('clinique', 'awa@test.sn', new Date(last), trusted)).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(await service.admit('clinique', 'awa@test.sn', new Date(last), context({ knownIp: true }))).toMatchObject({ allowed: false, retryAfterSeconds: 120 });
  });

  it('n’évalue pas le contexte tant que le compteur du compte n’impose aucun délai', async () => {
    const { service, store } = setup();
    const probe = vi.fn(context({ trustedNetwork: true }));
    await fail(store, 4, T0);

    expect((await service.admit('clinique', 'awa@test.sn', new Date(T0), probe)).key).toBe(ACCOUNT_KEY);
    expect(probe).not.toHaveBeenCalled();
  });

  it('sans IP cliente, le compteur du compte s’applique', async () => {
    const { service, store } = setup();
    await fail(store, 8, T0);
    expect(await service.admit('clinique', 'awa@test.sn', new Date(T0), context({ ip: null, trustedNetwork: true }))).toMatchObject({ allowed: false, key: ACCOUNT_KEY });
  });

  it('release retire la tentative réservée, sur le compteur qui l’a réservée', async () => {
    const { service, store } = setup();
    for (let i = 0; i < 5; i += 1) await service.admit('clinique', 'awa@test.sn', new Date(T0));
    const last = await service.admit('clinique', 'awa@test.sn', new Date(T0 + 30 * SECOND));

    await service.release(last);
    expect(await service.retryAfterSeconds('clinique', 'awa@test.sn', new Date(T0))).toBe(30);

    await fail(store, 3, T0);
    const known = await service.admit('clinique', 'awa@test.sn', new Date(T0), context({ knownIp: true }));
    await service.release(known);
    expect(await store.get(known.key)).toBeNull();
    expect((await store.get(ACCOUNT_KEY))?.count).toBe(8);
  });

  it('clear après une réussite depuis un contexte connu efface ce compteur seul : les échecs venus d’ailleurs demeurent', async () => {
    const { service, store } = setup();
    await fail(store, 8, T0);
    const known = await service.admit('clinique', 'awa@test.sn', new Date(T0), context({ knownIp: true }));

    await service.clear('clinique', 'awa@test.sn', known);

    expect(await store.get(known.key)).toBeNull();
    expect((await store.get(ACCOUNT_KEY))?.count).toBe(8);
  });

  it('clear sans admission (déverrouillage) efface le compteur du compte', async () => {
    const { service, store } = setup();
    await fail(store, 8, T0);
    await service.clear('clinique', 'awa@test.sn');
    expect(await store.get(ACCOUNT_KEY)).toBeNull();
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
