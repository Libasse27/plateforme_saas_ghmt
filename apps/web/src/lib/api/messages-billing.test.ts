import { describe, expect, it } from 'vitest';
import { describeApiError } from './messages';

const NBSP = ' ';

describe('codes de facturation, caisse et paiements', () => {
  it('amount_exceeds_balance affiche le reste dû formaté', () => {
    const message = describeApiError({ status: 422, code: 'amount_exceeds_balance', extras: { details: { balance: '12500.00' } } }, { currency: 'XOF' });
    expect(message).toContain(`12${NBSP}500${NBSP}FCFA`);
    expect(message).toContain('reste dû');
  });
  it('amount_exceeds_balance sans détail reste lisible', () => {
    expect(describeApiError({ status: 422, code: 'amount_exceeds_balance' })).toContain('reste dû');
    expect(describeApiError({ status: 422, code: 'amount_exceeds_balance', extras: { details: 'x' } })).toContain('reste dû');
  });
  it('traduit les erreurs d\'encaissement', () => {
    expect(describeApiError({ status: 409, code: 'payment_already_pending' })).toContain('en attente');
    expect(describeApiError({ status: 409, code: 'cash_session_not_open' })).toContain('session de caisse');
    expect(describeApiError({ status: 403, code: 'cash_session_not_owned' })).toContain('votre');
    expect(describeApiError({ status: 409, code: 'invoice_not_payable' })).toContain('encaissée');
    expect(describeApiError({ status: 409, code: 'cash_session_already_open' })).toContain('déjà');
  });
  it('explique la séparation des tâches de caisse', () => {
    const message = describeApiError({ status: 403, code: 'separation_of_duties' });
    expect(message).toContain('autre utilisateur');
  });
  it('traduit les erreurs de facture et de grille', () => {
    for (const code of ['invoice_not_draft', 'invoice_has_payments', 'invoice_already_void', 'free_line_forbidden', 'price_list_code_taken', 'price_list_item_code_taken', 'cash_register_code_taken', 'cash_session_not_closed', 'cash_session_not_owner']) {
      expect(describeApiError({ status: 409, code })).not.toContain('conflit avec des données');
    }
  });
});

describe('codes d\'abonnement', () => {
  it('downgrade_incompatible liste les dépassements', () => {
    const message = describeApiError({
      status: 409,
      code: 'downgrade_incompatible',
      extras: { details: { violations: [{ metric: 'users', limit: 5, current: 8 }, { metric: 'sites', limit: 1, current: 2 }] } },
    });
    expect(message).toContain('utilisateurs : 8 en cours pour 5 autorisés');
    expect(message).toContain('sites : 2 en cours pour 1 autorisé');
  });
  it('downgrade_incompatible sans détail', () => {
    expect(describeApiError({ status: 409, code: 'downgrade_incompatible' })).toContain('limites');
  });
  it('plan_limit_reached cite la métrique', () => {
    expect(describeApiError({ status: 403, code: 'plan_limit_reached', extras: { details: { metric: 'users', limit: 5, current: 5 } } })).toContain('utilisateurs');
    expect(describeApiError({ status: 403, code: 'plan_limit_reached' })).toContain('limite');
  });
  it('traduit les autres codes d\'abonnement', () => {
    for (const code of ['no_change', 'invalid_state', 'subscription_grace', 'payments_unavailable']) {
      expect(describeApiError({ status: 409, code }).length).toBeGreaterThan(20);
    }
    expect(describeApiError({ status: 503, code: 'payments_unavailable' })).toContain('paiement');
  });
});

describe('codes de la console plateforme', () => {
  it('four_eyes_required explique la règle des quatre yeux', () => {
    expect(describeApiError({ status: 403, code: 'four_eyes_required' })).toContain('autre administrateur');
  });
  it('traduit les erreurs de console', () => {
    for (const code of ['already_suspended', 'not_manually_suspended', 'trial_already_extended', 'not_in_trial', 'plan_version_conflict', 'amount_mismatch', 'manual_payment_pending', 'manual_payment_decided', 'mfa_enrollment_required']) {
      expect(describeApiError({ status: 409, code })).not.toContain('conflit avec des données');
    }
  });
});
