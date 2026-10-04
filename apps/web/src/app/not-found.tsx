import Link from 'next/link';
import { buttonClass } from '@/components/ui/styles';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-2xl font-bold">Page introuvable</h1>
      <p className="mt-2 text-slate-800">Cette page n&apos;existe pas ou vous n&apos;y avez pas accès.</p>
      <Link href="/" className={`${buttonClass.primary} mt-4`}>Retour à l&apos;accueil</Link>
    </main>
  );
}
