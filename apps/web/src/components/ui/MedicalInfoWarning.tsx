import { MEDICAL_INFO_WARNING } from '@/lib/domain/billing';

/** Rappel placé sous les champs libres de facturation : aucune donnée de santé dans la facturation. */
export function MedicalInfoWarning({ id }: { readonly id?: string }) {
  return (
    <p id={id} className="text-sm font-medium text-amber-900">
      {MEDICAL_INFO_WARNING}
    </p>
  );
}
