import { describe, expect, it } from 'vitest';
import {
  canPaySaasInvoice,
  changeResultMessage,
  checkoutRedirectTarget,
  subscriptionBanner,
  subscriptionHeadline,
  toChangePlanResult,
  toPayCheckout,
  toPublicPlan,
  toSaasInvoice,
  toSubscription,
  usageRows,
} from './subscription';

const NOW = new Date('2026-10-04T10:00:00.000Z');

const RAW_SUB = {
  id: 's1',
  status: 'trial',
  billingPeriod: 'monthly',
  currentPeriodStart: '2026-09-20T00:00:00.000Z',
  currentPeriodEnd: '2026-10-20T00:00:00.000Z',
  trialEndsAt: '2026-10-20T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  plan: { id: 'p1', code: 'basic', version: 1, name: 'Basic', tier: 'basic', priceMonthly: '25000.00', priceYearly: '250000.00', currency: 'XOF' },
  pendingChange: null,
  entitlements: {
    modules: ['billing', 'cashier'],
    limits: { users: 5, sites: 1, appointmentsMonthly: 500, activePatients: 2000, smsMonthly: 200, storageGb: null },
    features: { customRoles: false, export: true, api: false },
  },
  usage: { users: 5, sites: 1, appointmentsThisMonth: 650 },
};

describe('toSubscription', () => {
  it('mappe la réponse de GET /subscription', () => {
    const sub = toSubscription(RAW_SUB);
    expect(sub).toMatchObject({ id: 's1', status: 'trial', billingPeriod: 'monthly', cancelAtPeriodEnd: false, pendingChange: null });
    expect(sub?.plan).toMatchObject({ code: 'basic', priceMonthly: '25000.00' });
    expect(sub?.entitlements.limits.storageGb).toBeNull();
    expect(sub?.entitlements.features.export).toBe(true);
    expect(sub?.usage).toEqual({ users: 5, sites: 1, appointmentsThisMonth: 650 });
  });
  it('mappe un changement programmé', () => {
    const sub = toSubscription({ ...RAW_SUB, status: 'active', pendingChange: { planCode: 'basic', billingPeriod: 'yearly', effectiveAt: '2026-10-20T00:00:00.000Z' } });
    expect(sub?.pendingChange).toEqual({ planCode: 'basic', billingPeriod: 'yearly', effectiveAt: '2026-10-20T00:00:00.000Z' });
  });
  it('renvoie null sans statut valide et tolère les champs manquants', () => {
    expect(toSubscription(null)).toBeNull();
    expect(toSubscription({ id: 'x', status: 'bizarre' })).toBeNull();
    const minimal = toSubscription({ id: 'x', status: 'active' });
    expect(minimal?.plan.name).toBe('Plan');
    expect(minimal?.entitlements.limits.users).toBeNull();
    expect(minimal?.billingPeriod).toBe('monthly');
  });
});

describe('toPublicPlan / toSaasInvoice / toPayCheckout / toChangePlanResult', () => {
  it('mappe une offre publique', () => {
    expect(toPublicPlan({ ...RAW_SUB.plan, entitlements: RAW_SUB.entitlements })).toMatchObject({ code: 'basic', tier: 'basic', priceYearly: '250000.00' });
    expect(toPublicPlan(undefined).code).toBe('');
  });
  it('mappe une facture SaaS avec ses lignes', () => {
    const invoice = toSaasInvoice({
      id: 'i1', number: 'GHMT-SN-2026-000001', status: 'open', kind: 'renewal', currency: 'XOF', subtotal: '25000.00', taxRate: '0.1800', taxAmount: '4500.00', total: '29500.00',
      periodStart: 'a', periodEnd: 'b', issuedAt: 'c', dueAt: 'd', paidAt: null,
      lines: [{ description: 'Abonnement Basic', quantity: 1, unitPrice: '25000.00', amount: '25000.00' }],
    });
    expect(invoice).toMatchObject({ number: 'GHMT-SN-2026-000001', status: 'open', total: '29500.00', paidAt: null });
    expect(invoice.lines).toEqual([{ description: 'Abonnement Basic', quantity: 1, unitPrice: '25000.00', amount: '25000.00' }]);
    expect(toSaasInvoice(null)).toMatchObject({ status: 'open', total: '0.00', lines: [] });
  });
  it('mappe la réponse de paiement', () => {
    expect(toPayCheckout({ attemptId: 'a', status: 'pending', provider: 'sandbox', checkoutUrl: 'https://pay.test/x', instructions: 'Validez' })).toEqual({
      attemptId: 'a', status: 'pending', provider: 'sandbox', checkoutUrl: 'https://pay.test/x', instructions: 'Validez',
    });
    expect(toPayCheckout({})).toMatchObject({ checkoutUrl: null, instructions: null });
  });
  it('mappe le résultat d\'un changement de plan', () => {
    expect(toChangePlanResult({ effect: 'scheduled', subscription: RAW_SUB, invoice: null })).toMatchObject({ effect: 'scheduled', invoice: null });
    expect(toChangePlanResult({ effect: 'immediate', invoice: { number: 'F1', total: '1.00' } }).invoice?.number).toBe('F1');
    expect(toChangePlanResult({ effect: '???' }).effect).toBe('immediate');
  });
});

describe('bandeau global d\'abonnement', () => {
  it('est absent pour essai, actif et résilié', () => {
    for (const status of ['trial', 'active', 'cancelled'] as const) expect(subscriptionBanner(status)).toBeNull();
  });
  it('avertit en retard, grâce, suspendu et expiré avec un message explicite', () => {
    expect(subscriptionBanner('past_due')).toMatchObject({ tone: 'warning' });
    expect(subscriptionBanner('past_due')?.message).toContain('retard');
    expect(subscriptionBanner('grace')?.message).toContain('grâce');
    expect(subscriptionBanner('suspended')).toMatchObject({ tone: 'error' });
    expect(subscriptionBanner('suspended')?.message).toContain('lecture seule');
    expect(subscriptionBanner('expired')?.tone).toBe('error');
  });
});

describe('subscriptionHeadline', () => {
  it('essai : J-x et date de fin', () => {
    const sub = toSubscription(RAW_SUB)!;
    expect(subscriptionHeadline(sub, NOW, 'Africa/Dakar')).toContain('J-16');
    expect(subscriptionHeadline(sub, NOW, 'Africa/Dakar')).toContain('20/10/2026');
  });
  it('essai terminé aujourd\'hui', () => {
    const sub = toSubscription({ ...RAW_SUB, trialEndsAt: '2026-10-03T00:00:00.000Z' })!;
    expect(subscriptionHeadline(sub, NOW, 'Africa/Dakar')).toContain('se termine aujourd');
  });
  it('actif : renouvellement ; résiliation programmée', () => {
    const active = toSubscription({ ...RAW_SUB, status: 'active' })!;
    expect(subscriptionHeadline(active, NOW, 'Africa/Dakar')).toContain('renouvelé');
    const cancelling = toSubscription({ ...RAW_SUB, status: 'active', cancelAtPeriodEnd: true })!;
    expect(subscriptionHeadline(cancelling, NOW, 'Africa/Dakar')).toContain('prendra fin le 20/10/2026');
  });
  it('autres statuts', () => {
    for (const [status, text] of [['past_due', 'retard'], ['grace', 'grâce'], ['suspended', 'suspendu'], ['cancelled', 'résilié'], ['expired', 'expiré']] as const) {
      expect(subscriptionHeadline(toSubscription({ ...RAW_SUB, status })!, NOW, 'Africa/Dakar')).toContain(text);
    }
  });
});

describe('usageRows', () => {
  it('compare l\'usage aux limites et signale les dépassements', () => {
    const rows = usageRows(toSubscription(RAW_SUB)!);
    expect(rows).toEqual([
      { key: 'users', label: 'Utilisateurs', used: 5, limit: 5, over: false, atLimit: true },
      { key: 'sites', label: 'Sites', used: 1, limit: 1, over: false, atLimit: true },
      { key: 'appointments', label: 'Rendez-vous du mois', used: 650, limit: 500, over: true, atLimit: true },
    ]);
  });
  it('illimité si la limite est nulle', () => {
    const sub = toSubscription({ ...RAW_SUB, entitlements: { ...RAW_SUB.entitlements, limits: { ...RAW_SUB.entitlements.limits, users: null } } })!;
    expect(usageRows(sub)[0]).toMatchObject({ limit: null, over: false, atLimit: false });
  });
});

describe('changeResultMessage', () => {
  const sub = toSubscription(RAW_SUB)!;
  it('immediate / scheduled / pending_payment', () => {
    expect(changeResultMessage({ effect: 'immediate', subscription: sub, invoice: null }, 'Africa/Dakar')).toContain('immédiatement');
    const scheduled = changeResultMessage({ effect: 'scheduled', subscription: { ...sub, pendingChange: { planCode: 'basic', billingPeriod: 'yearly', effectiveAt: '2026-10-20T00:00:00.000Z' } }, invoice: null }, 'Africa/Dakar');
    expect(scheduled).toContain('20/10/2026');
    const pending = changeResultMessage({ effect: 'pending_payment', subscription: sub, invoice: toSaasInvoice({ number: 'GHMT-1', total: '1000.00', currency: 'XOF' }) }, 'Africa/Dakar');
    expect(pending).toContain('GHMT-1');
    expect(pending).toContain('paiement');
  });
  it('mentionne la facture émise lors d\'un changement immédiat', () => {
    expect(changeResultMessage({ effect: 'immediate', subscription: sub, invoice: toSaasInvoice({ number: 'GHMT-2', total: '500.00' }) }, 'Africa/Dakar')).toContain('GHMT-2');
  });
  it('changement programmé sans date', () => {
    expect(changeResultMessage({ effect: 'scheduled', subscription: sub, invoice: null }, 'Africa/Dakar')).toContain('fin de la période');
  });
});

describe('paiement des factures SaaS', () => {
  it('seules les factures ouvertes sont payables', () => {
    expect(canPaySaasInvoice('open')).toBe(true);
    for (const status of ['draft', 'paid', 'void', 'uncollectible'] as const) expect(canPaySaasInvoice(status)).toBe(false);
  });
  it('checkoutRedirectTarget accepte https et ajoute le retour pour la page sandbox', () => {
    expect(checkoutRedirectTarget('https://pay.cinetpay.test/abc', '/abonnement', false)).toBe('https://pay.cinetpay.test/abc');
    expect(checkoutRedirectTarget('http://localhost:3001/sandbox/paiement/ref12345678', '/abonnement', false)).toBe(
      'http://localhost:3001/sandbox/paiement/ref12345678?retour=%2Fabonnement',
    );
  });
  it('refuse les schémas dangereux, le http en production et les valeurs vides', () => {
    expect(checkoutRedirectTarget('javascript:alert(1)', '/abonnement', false)).toBeNull();
    expect(checkoutRedirectTarget('//evil.test', '/abonnement', false)).toBeNull();
    expect(checkoutRedirectTarget('http://pay.test/x', '/abonnement', true)).toBeNull();
    expect(checkoutRedirectTarget('https://pay.test/x', '/abonnement', true)).toBe('https://pay.test/x');
    expect(checkoutRedirectTarget(null, '/abonnement', false)).toBeNull();
    expect(checkoutRedirectTarget('pas une url', '/abonnement', false)).toBeNull();
  });
});

describe('statusTone', () => {
  it('associe une teinte à chaque statut', async () => {
    const { statusTone } = await import('./subscription');
    expect(statusTone('active')).toBe('success');
    expect(statusTone('trial')).toBe('info');
    expect(statusTone('grace')).toBe('warning');
    expect(statusTone('suspended')).toBe('danger');
    expect(statusTone('cancelled')).toBe('neutral');
  });
});
