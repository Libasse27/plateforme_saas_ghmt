import { ApiError } from './errors';
import type { ApiMeta, ApiSuccess, FieldIssue } from './types';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toFieldIssues(raw: unknown): FieldIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): FieldIssue[] => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.message !== 'string') return [];
    return [{ path: entry.path, code: typeof entry.code === 'string' ? entry.code : 'invalid', message: entry.message }];
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const STANDARD_MEMBERS: ReadonlySet<string> = new Set(['status', 'code', 'title', 'detail', 'errors', 'requestId']);

function toApiError(status: number, problem: UnknownRecord, meta: UnknownRecord | undefined): ApiError {
  const { code, title, detail, errors, requestId } = problem;
  const extras = Object.fromEntries(Object.entries(problem).filter(([key]) => !STANDARD_MEMBERS.has(key)));
  const effectiveStatus = typeof problem.status === 'number' ? problem.status : status;
  return new ApiError({
    status: effectiveStatus,
    code: asString(code) ?? `http_${effectiveStatus}`,
    title: asString(title),
    detail: asString(detail),
    errors: toFieldIssues(errors),
    requestId: asString(requestId) ?? asString(meta?.requestId),
    extras,
  });
}

/** Lit une réponse HTTP : renvoie data/meta en cas de succès, lève ApiError sinon. */
export async function readEnvelope<T = unknown>(response: Response): Promise<ApiSuccess<T>> {
  if (response.status === 204) return { data: null as T, meta: {}, status: 204 };

  const body = await parseBody(response);
  const record = isRecord(body) ? body : undefined;
  const meta = record && isRecord(record.meta) ? record.meta : undefined;

  const failedInEnvelope = record?.success === false;
  if (!response.ok || failedInEnvelope) {
    const problem = record && isRecord(record.error) ? record.error : (record ?? {});
    throw toApiError(response.ok ? 400 : response.status, problem, meta);
  }

  const data = record && 'success' in record ? record.data : body;
  return { data: data as T, meta: (meta ?? {}) as ApiMeta, status: response.status };
}
