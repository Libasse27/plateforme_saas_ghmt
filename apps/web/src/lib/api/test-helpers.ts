/** Utilitaires de test : fabrique de réponses HTTP conformes à docs/03 §2.2 et §2.5. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function okEnvelope(data: unknown, meta: Record<string, unknown> = {}, status = 200): Response {
  return jsonResponse(status, { success: true, data, error: null, meta: { requestId: 'req-1', ...meta } });
}

export function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(status, {
    success: false,
    data: null,
    error: { status, code, title: code, detail: `detail ${code}`, ...extra },
    meta: { requestId: 'req-1' },
  });
}
