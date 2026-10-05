import { vi } from 'vitest';
import { jsonResponse, okEnvelope } from '@/lib/api/test-helpers';

/** Redirection simulée de `next/navigation` : permet d'asserter la cible. */
export class Redirect extends Error {
  constructor(readonly url: string) {
    super(`REDIRECT:${url}`);
  }
}

export function navigationMock() {
  return {
    redirect: (url: string) => {
      throw new Redirect(url);
    },
    notFound: () => {
      throw new Error('NOT_FOUND');
    },
  };
}

export function cacheMock() {
  return { revalidatePath: vi.fn() };
}

/** Cookies de session établissement (ghmt_at) et plateforme (ghmt_pat) présents ; les écritures sont ignorées. */
export function headersMock() {
  const values: Record<string, string> = { ghmt_at: 'tenant-access', ghmt_rt: 'tenant-refresh', ghmt_pat: 'platform-access', ghmt_prt: 'p.platform-refresh-1234' };
  return {
    cookies: async () => ({
      get: (name: string) => (name in values ? { name, value: values[name] } : undefined),
      set: vi.fn(),
    }),
    headers: async () => new Headers(),
  };
}

export async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Redirect) return error.url;
    throw error;
  }
  throw new Error('aucune redirection');
}

export function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

export const ME = {
  user: { id: 'u-me', fullName: 'Awa Caissière', email: 'awa@clinique.sn', mustChangePassword: false },
  tenant: { id: 't1', slug: 'clinique-a', name: 'Clinique A', timezone: 'Africa/Dakar', countryCode: 'SN', baseCurrency: 'XOF' },
  permissions: ['billing:invoice:read', 'billing:invoice:create', 'cashier:payment:create'],
  modules: ['billing', 'cashier'],
  mfa: { enrolled: true, verified: true, required: true },
};

export interface RecordedCall {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

type Handler = (call: RecordedCall) => Response | Promise<Response> | undefined;

/** Remplace `fetch` : /auth/me répond ME par défaut ; le gestionnaire fourni traite le reste (404 par défaut). */
export function stubApi(handler: Handler, me: unknown = ME): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: RecordedCall = {
        url,
        path: new URL(url).pathname.replace(/^\/api\/v1/, ''),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        authorization: headers.authorization,
      };
      calls.push(call);
      if (call.path === '/auth/me') return okEnvelope(me);
      return (await handler(call)) ?? jsonResponse(404, { success: false, error: { status: 404, code: 'not_found' } });
    }),
  );
  return { calls };
}
