import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { readEnvelope } from './envelope';
import { jsonResponse, okEnvelope, problem } from './test-helpers';

describe('readEnvelope', () => {
  it('extrait data et meta d\'une réponse enveloppée', async () => {
    const result = await readEnvelope(
      okEnvelope([{ id: 1 }], { pagination: { nextCursor: 'abc', hasMore: true } }),
    );
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.meta.pagination).toEqual({ nextCursor: 'abc', hasMore: true });
    expect(result.meta.requestId).toBe('req-1');
    expect(result.status).toBe(200);
  });

  it('renvoie data null pour un 204', async () => {
    const result = await readEnvelope(new Response(null, { status: 204 }));
    expect(result.data).toBeNull();
  });

  it('traite un corps sans enveloppe comme la donnée elle-même', async () => {
    const result = await readEnvelope(jsonResponse(200, { hello: 'monde' }));
    expect(result.data).toEqual({ hello: 'monde' });
  });

  it('lève ApiError avec code, détail et erreurs de champ pour un 422 enveloppé', async () => {
    const res = problem(422, 'validation_failed', { errors: [{ path: 'firstName', code: 'too_small', message: 'Le prénom est obligatoire.' }] });
    const error = await readEnvelope(res).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe('validation_failed');
    expect(apiError.errors).toEqual([{ path: 'firstName', code: 'too_small', message: 'Le prénom est obligatoire.' }]);
    expect(apiError.requestId).toBe('req-1');
  });

  it('lit un problem+json nu (sans enveloppe)', async () => {
    const res = jsonResponse(409, { status: 409, code: 'patient_duplicate_suspected', detail: 'Doublon', candidates: [{ id: 'x' }] });
    const apiError = (await readEnvelope(res).catch((e: unknown) => e)) as ApiError;
    expect(apiError.code).toBe('patient_duplicate_suspected');
    expect(apiError.extras.candidates).toEqual([{ id: 'x' }]);
  });

  it('déduit le code du statut quand le corps est illisible', async () => {
    const res = new Response('<html>Bad gateway</html>', { status: 502 });
    const apiError = (await readEnvelope(res).catch((e: unknown) => e)) as ApiError;
    expect(apiError.status).toBe(502);
    expect(apiError.code).toBe('http_502');
    expect(apiError.errors).toEqual([]);
  });

  it('ignore les entrées errors[] mal formées', async () => {
    const res = problem(422, 'validation_failed', { errors: [null, { path: 1 }, { path: 'a', message: 'm' }] });
    const apiError = (await readEnvelope(res).catch((e: unknown) => e)) as ApiError;
    expect(apiError.errors).toEqual([{ path: 'a', code: 'invalid', message: 'm' }]);
  });

  it('traite success:false avec statut 200 comme une erreur', async () => {
    const res = jsonResponse(200, { success: false, data: null, error: { status: 400, code: 'bad' } });
    const apiError = (await readEnvelope(res).catch((e: unknown) => e)) as ApiError;
    expect(apiError.code).toBe('bad');
    expect(apiError.status).toBe(400);
  });
});
