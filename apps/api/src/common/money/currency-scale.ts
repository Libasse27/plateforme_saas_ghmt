import { currencyScale, hasValidCurrencyScale } from '@ghmt/shared';
import { DomainError } from '../errors/domain-error';

export { currencyScale };

/** 422 `amount_scale` : les devises sans subdivision (XOF, XAF, GNF, CDF) n'admettent que des montants entiers (docs/09 §R7). */
export function assertAmountScale(amount: string, currency: string, path = 'amount'): void {
  if (hasValidCurrencyScale(amount, currency)) return;
  throw new DomainError('amount_scale', 422, 'Unprocessable Entity', `Le montant doit être entier en ${currency} (pas de décimales).`, {
    errors: [{ path, code: 'amount_scale', message: `Montant entier attendu en ${currency}.` }],
  });
}
