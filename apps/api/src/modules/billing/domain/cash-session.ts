import { subtractMoney, addMoney, type Money } from '../../../common/money/money';

export function expectedCashTotal(openingFloat: Money, cashCollected: Money): Money {
  return addMoney(openingFloat, cashCollected);
}

/** Positif = excédent, négatif = manque. */
export function cashVariance(counted: Money, expected: Money): Money {
  return subtractMoney(counted, expected);
}

/** Séparation des tâches : le validateur n'est ni l'ouvreur ni celui qui a clôturé la session. */
export function mayValidateSession(session: { readonly openedBy: string; readonly closedBy: string | null }, validatorId: string): boolean {
  return validatorId !== session.openedBy && validatorId !== session.closedBy;
}
