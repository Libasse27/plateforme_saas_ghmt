import { notFound } from 'next/navigation';
import { settle, type Settled } from '@/lib/api/settle';
import type { QueryValue } from '@/lib/api/client';
import type { ApiMeta } from '@/lib/api/types';
import { items } from '@/lib/domain/raw';
import { pageApi } from '@/server/api';

export type Loaded<T> = { readonly ok: true; readonly value: T; readonly meta: ApiMeta } | { readonly ok: false; readonly message: string };

/** Charge une fiche : 404 → page introuvable, autre erreur d'API → message français à afficher. */
export async function loadOne<T>(path: string, map: (raw: unknown) => T): Promise<Loaded<T>> {
  const result = await settle(() => pageApi(path));
  if (!result.ok) {
    if (result.status === 404) notFound();
    return { ok: false, message: result.message };
  }
  return { ok: true, value: map(result.value.data), meta: result.value.meta };
}

/** Charge une liste (tableau de données) avec sa pagination. */
export async function loadList<T>(path: string, map: (raw: unknown) => T, query?: Readonly<Record<string, QueryValue>>): Promise<Loaded<T[]>> {
  const result = await settle(() => pageApi(path, query ? { query } : {}));
  return result.ok ? { ok: true, value: items(result.value.data, map), meta: result.value.meta } : { ok: false, message: result.message };
}

/** Liste facultative (menus déroulants) : un refus ou une panne donne simplement une liste vide. */
export async function loadOptional<T>(allowed: boolean, path: string, map: (raw: unknown) => T, query?: Readonly<Record<string, QueryValue>>): Promise<T[]> {
  if (!allowed) return [];
  const loaded = await loadList(path, map, query);
  return loaded.ok ? loaded.value : [];
}

export function nextCursorOf(meta: ApiMeta): string | null {
  return meta.pagination?.hasMore ? (meta.pagination.nextCursor ?? null) : null;
}

export type { Settled };
