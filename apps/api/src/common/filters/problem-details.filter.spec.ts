import { Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../context/request-context';
import { DomainError } from '../errors/domain-error';
import { ProblemDetailsFilter, summarizeError } from './problem-details.filter';

function fakeHost(accept = '') {
  const send = vi.fn();
  const res = { status: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), send, setHeader: vi.fn() };
  const req = { originalUrl: '/api/v1/patients?q=secret', header: () => accept };
  const host = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ArgumentsHost;
  return { host, res, send };
}

const context = { requestId: 'req-12345678' } as unknown as RequestContext;

afterEach(() => vi.restoreAllMocks());

describe('summarizeError (A12)', () => {
  it('ne conserve que nom, code et message tronqué à 200 caractères', () => {
    const error = Object.assign(new Error('x'.repeat(500)), { code: 'ECONNRESET', meta: { sql: 'SELECT * FROM patients', params: ['Awa Diop'] } });
    const summary = summarizeError(error);
    expect(Object.keys(summary).sort()).toEqual(['code', 'message', 'name']);
    expect(summary.message).toHaveLength(200);
    expect(summary).toMatchObject({ name: 'Error', code: 'ECONNRESET' });
  });

  it('ne journalise jamais le message d’une erreur Prisma (code P…) : seulement name et code', () => {
    const error = Object.assign(new Error('Invalid `prisma.patient.create()` invocation: phone_bidx = Awa Diop'), { name: 'PrismaClientKnownRequestError', code: 'P2010' });
    const summary = summarizeError(error);
    expect(summary).toEqual({ name: 'PrismaClientKnownRequestError', code: 'P2010' });
    expect(JSON.stringify(summary)).not.toContain('Awa');
  });

  it('traite aussi comme Prisma une erreur dont le nom commence par Prisma, même sans code', () => {
    const error = Object.assign(new Error('secret: Awa Diop'), { name: 'PrismaClientValidationError' });
    expect(summarizeError(error)).toEqual({ name: 'PrismaClientValidationError', code: null });
  });

  it('conserve le message tronqué d’une erreur non Prisma dont le code ne commence pas par P', () => {
    expect(summarizeError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toMatchObject({ message: 'boom' });
  });

  it('tolère les valeurs non-erreurs', () => {
    expect(summarizeError(undefined)).toEqual({ name: 'undefined', code: null, message: '' });
    expect(summarizeError('boom')).toMatchObject({ name: 'string' });
  });
});

describe('ProblemDetailsFilter', () => {
  it('journalise un résumé sans l’erreur brute pour une erreur 500, et masque le détail au client', () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, send } = fakeHost();
    const raw = Object.assign(new Error('insert into patients values (Awa Diop)'), { meta: { params: ['Awa Diop'] } });

    new ProblemDetailsFilter(context).catch(raw, host);

    const [payload] = logError.mock.calls[0]!;
    expect(JSON.stringify(payload)).not.toContain('meta');
    expect(payload).toMatchObject({ requestId: 'req-12345678', error: { name: 'Error' } });
    expect(String(send.mock.calls[0]![0])).not.toContain('Awa Diop');
  });

  it('sérialise details et retire la query string de instance', () => {
    const { host, send } = fakeHost('application/problem+json');
    const error = DomainError.conflict('patient_duplicate', 'Doublon', { details: { candidates: [{ id: '1' }] } });

    new ProblemDetailsFilter(context).catch(error, host);

    const body = JSON.parse(String(send.mock.calls[0]![0]));
    expect(body).toMatchObject({ status: 409, code: 'patient_duplicate', instance: '/api/v1/patients', details: { candidates: [{ id: '1' }] } });
  });
});
