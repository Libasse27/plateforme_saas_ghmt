import { Alert } from './Alert';

export function AccessDenied({ what = 'cette page' }: { readonly what?: string }) {
  return (
    <Alert tone="warning">
      Vous n&apos;avez pas accès à {what}. Si vous pensez qu&apos;il s&apos;agit d&apos;une erreur, contactez l&apos;administrateur de votre établissement.
    </Alert>
  );
}
