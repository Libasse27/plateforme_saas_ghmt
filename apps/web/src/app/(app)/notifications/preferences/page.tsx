import type { Metadata } from 'next';
import Link from 'next/link';
import { PreferencesForm } from '@/components/notifications/PreferencesForm';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { toPreferences } from '@/lib/domain/notifications';
import { requireMe } from '@/server/me';
import { loadOne } from '../../administration/_lib/page-data';

export const metadata: Metadata = { title: 'Préférences de notification' };

export default async function PreferencesPage() {
  await requireMe();
  const result = await loadOne('/notifications/preferences', toPreferences);
  return (
    <>
      <PageHeader title="Préférences de notification" description="Choisissez comment recevoir les notifications administratives. Les canaux verrouillés ne peuvent pas être désactivés." />
      <div className="max-w-xl space-y-4">
        {result.ok ? <PreferencesForm preferences={result.value} /> : <Alert tone="error">{result.message}</Alert>}
        <p><Link href="/notifications" className="text-blue-800 underline">Retour aux notifications</Link></p>
      </div>
    </>
  );
}
