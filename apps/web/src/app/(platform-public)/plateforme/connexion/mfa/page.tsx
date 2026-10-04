import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { platformMfaVerifyAction } from '@/actions/platform-auth';
import { MfaVerifyForm } from '@/components/forms/MfaVerifyForm';
import { PLATFORM_LOGIN_PATH } from '@/lib/auth/platform-me';
import { safePlatformPath } from '@/lib/forms';
import { readPlatformMfaChallenge } from '@/lib/session/platform-store';

export const metadata: Metadata = { title: 'Vérification en deux étapes' };

export default async function PlatformMfaChallengePage({ searchParams }: { readonly searchParams: Promise<{ next?: string }> }) {
  if (!(await readPlatformMfaChallenge())) redirect(`${PLATFORM_LOGIN_PATH}?session=expiree`);
  const { next } = await searchParams;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Vérification en deux étapes</h1>
      <MfaVerifyForm next={safePlatformPath(next)} action={platformMfaVerifyAction} />
    </div>
  );
}
