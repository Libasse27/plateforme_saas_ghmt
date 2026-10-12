import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { eicar } from '../../../test/files/samples';
import { AntivirusUnavailableError, ClamdScanner, DisabledAntivirus } from './clamav-scanner';

type Reply = (socket: Socket, payload: Buffer) => void;

interface FakeClamd {
  readonly port: number;
  /** Contenu reçu par INSTREAM, reconstitué à partir des morceaux préfixés par leur taille. */
  readonly received: Buffer[];
  close(): Promise<void>;
}

/** Faux clamd : décode le protocole INSTREAM (commande `zINSTREAM\0`, morceaux [taille 4 o][données], fin à taille 0). */
async function fakeClamd(reply: Reply): Promise<FakeClamd> {
  const received: Buffer[] = [];
  const server: Server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffered = Buffer.concat([buffered, data]);
      if (buffered.subarray(0, 6).toString() === 'zPING\0') {
        socket.end('PONG\0');
        return;
      }
      if (buffered.subarray(0, 10).toString() !== 'zINSTREAM\0') return;
      const chunks: Buffer[] = [];
      let offset = 10;
      while (offset + 4 <= buffered.length) {
        const size = buffered.readUInt32BE(offset);
        if (size === 0) {
          const payload = Buffer.concat(chunks);
          received.push(payload);
          reply(socket, payload);
          return;
        }
        if (offset + 4 + size > buffered.length) return;
        chunks.push(buffered.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('adresse inattendue');
  return {
    port: address.port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const answer = (text: string): Reply => (socket) => socket.end(`${text}\0`);

describe('ClamdScanner (faux clamd)', () => {
  let server: FakeClamd | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('transmet le contenu par INSTREAM en morceaux et conclut « sain » sur OK', async () => {
    server = await fakeClamd(answer('stream: OK'));
    const content = Buffer.alloc(150_000, 7);

    const verdict = await new ClamdScanner({ host: '127.0.0.1', port: server.port, chunkBytes: 64 * 1024 }).scan(content);

    expect(verdict).toEqual({ status: 'clean' });
    expect(server.received[0]?.equals(content)).toBe(true);
  });

  it('conclut « infecté » avec la signature sur FOUND', async () => {
    server = await fakeClamd(answer('stream: Win.Test.EICAR_HDB-1 FOUND'));

    expect(await new ClamdScanner({ host: '127.0.0.1', port: server.port }).scan(eicar())).toEqual({
      status: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('lève AntivirusUnavailableError sur une erreur de clamd (limite de taille, réponse inconnue)', async () => {
    server = await fakeClamd(answer('INSTREAM size limit exceeded. ERROR'));

    await expect(new ClamdScanner({ host: '127.0.0.1', port: server.port }).scan(Buffer.from('x'))).rejects.toBeInstanceOf(AntivirusUnavailableError);
  });

  it('lève AntivirusUnavailableError si clamd coupe la connexion sans réponse', async () => {
    server = await fakeClamd((socket) => socket.destroy());

    await expect(new ClamdScanner({ host: '127.0.0.1', port: server.port }).scan(Buffer.from('x'))).rejects.toBeInstanceOf(AntivirusUnavailableError);
  });

  it('lève AntivirusUnavailableError au-delà du délai d’analyse', async () => {
    server = await fakeClamd(() => undefined);

    await expect(new ClamdScanner({ host: '127.0.0.1', port: server.port, timeoutMs: 100 }).scan(Buffer.from('x'))).rejects.toBeInstanceOf(
      AntivirusUnavailableError,
    );
  });

  it('lève AntivirusUnavailableError si clamd est coupé (connexion refusée)', async () => {
    const closed = await fakeClamd(answer('stream: OK'));
    const port = closed.port;
    await closed.close();

    await expect(new ClamdScanner({ host: '127.0.0.1', port }).scan(Buffer.from('x'))).rejects.toBeInstanceOf(AntivirusUnavailableError);
  });

  it('sonde clamd par PING', async () => {
    server = await fakeClamd(answer('stream: OK'));
    const scanner = new ClamdScanner({ host: '127.0.0.1', port: server.port });
    const port = server.port;

    expect(scanner.enabled).toBe(true);
    expect(await scanner.isReachable()).toBe(true);
    await server.close();
    server = undefined;
    expect(await new ClamdScanner({ host: '127.0.0.1', port }).isReachable()).toBe(false);
  });
});

describe('DisabledAntivirus (hors production, CLAMAV_HOST absent)', () => {
  it('se déclare désactivé et considère le contenu comme sain', async () => {
    const antivirus = new DisabledAntivirus();

    expect(antivirus.enabled).toBe(false);
    expect(await antivirus.scan()).toEqual({ status: 'clean' });
    expect(await antivirus.isReachable()).toBe(false);
  });
});

// Intégration réelle (docs/13 §11.2, étape 4) : seulement si un clamd de test est fourni (CLAMAV_TEST_HOST).
const realHost = process.env['CLAMAV_TEST_HOST'];
describe.skipIf(!realHost)('ClamdScanner (clamd réel)', () => {
  const scanner = new ClamdScanner({ host: realHost ?? '', port: Number(process.env['CLAMAV_TEST_PORT'] ?? 3310) });

  it('rejette EICAR et accepte un contenu sain', async () => {
    expect(await scanner.isReachable()).toBe(true);
    expect(await scanner.scan(eicar())).toMatchObject({ status: 'infected', signature: expect.stringMatching(/EICAR/i) });
    expect(await scanner.scan(Buffer.from('%PDF-1.7\nsain\n%%EOF'))).toEqual({ status: 'clean' });
  });
});
