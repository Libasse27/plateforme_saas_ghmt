import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationBell } from './NotificationBell';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => json(200, { count: 4, capped: false }));
  vi.stubGlobal('fetch', fetchMock);
  setHidden(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NotificationBell', () => {
  it('affiche le compteur initial et un nom accessible', () => {
    render(<NotificationBell initial={{ count: 3, capped: false }} />);
    const link = screen.getByRole('link', { name: 'Notifications, 3 non lues' });
    expect(link).toHaveAttribute('href', '/notifications');
    expect(link).toHaveTextContent('3');
  });
  it('sans compteur initial (échec serveur) : cloche sans nombre', () => {
    render(<NotificationBell initial={null} />);
    const link = screen.getByRole('link', { name: 'Notifications' });
    expect(link).toHaveAttribute('href', '/notifications');
    expect(link.textContent).not.toMatch(/\d/);
  });
  it('affiche « 99+ » au-delà de 99 et quand le compteur est plafonné', () => {
    const { rerender } = render(<NotificationBell initial={{ count: 150, capped: false }} />);
    expect(screen.getByRole('link')).toHaveTextContent('99+');
    rerender(<NotificationBell initial={{ count: 999, capped: true }} />);
    expect(screen.getByRole('link')).toHaveTextContent('99+');
  });
  it('rien à zéro, nom sans « non lues »', () => {
    render(<NotificationBell initial={{ count: 0, capped: false }} />);
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
  });
  it('interroge /notifications/compteur toutes les 60 s et met à jour le compteur', async () => {
    render(<NotificationBell initial={{ count: 1, capped: false }} />);
    expect(fetchMock).not.toHaveBeenCalled();
    await tick(59_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await tick(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/notifications/compteur');
    expect(screen.getByRole('link')).toHaveTextContent('4');
    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('suspend le polling onglet masqué et reprend à son retour', async () => {
    render(<NotificationBell initial={{ count: 1, capped: false }} />);
    act(() => setHidden(true));
    await tick(180_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('backoff exponentiel en cas d\'erreur, plafonné à 5 minutes', async () => {
    fetchMock.mockImplementation(async () => json(503, {}));
    render(<NotificationBell initial={{ count: 1, capped: false }} />);
    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(119_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(240_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await tick(299_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await tick(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await tick(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it('une erreur réseau compte aussi comme échec, puis la reprise remet le rythme à 60 s', async () => {
    fetchMock.mockRejectedValueOnce(new Error('réseau'));
    render(<NotificationBell initial={{ count: 1, capped: false }} />);
    await tick(60_000);
    await tick(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('s\'arrête définitivement sur 401', async () => {
    fetchMock.mockImplementation(async () => json(401, {}));
    render(<NotificationBell initial={{ count: 1, capped: false }} />);
    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('se resynchronise quand le serveur fournit un nouveau compteur', () => {
    const { rerender } = render(<NotificationBell initial={{ count: 5, capped: false }} />);
    rerender(<NotificationBell initial={{ count: 0, capped: false }} />);
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
  });
  it('nettoie le minuteur au démontage', async () => {
    const { unmount } = render(<NotificationBell initial={{ count: 1, capped: false }} />);
    unmount();
    await tick(120_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
