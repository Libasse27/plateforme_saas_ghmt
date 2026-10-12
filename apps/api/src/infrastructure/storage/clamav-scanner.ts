import { connect } from 'node:net';

/** Jeton d'injection de l'antivirus (docs/13 D5). */
export const ANTIVIRUS = Symbol('ANTIVIRUS');

export type ScanVerdict = { readonly status: 'clean' } | { readonly status: 'infected'; readonly signature: string };

export interface Antivirus {
  /** `false` : analyse ignorée (hors production sans `CLAMAV_HOST`), la sonde affiche `disabled`. */
  readonly enabled: boolean;
  /** Lève `AntivirusUnavailableError` si l'analyse n'a pas pu aboutir (le fichier reste alors `pending`). */
  scan(content: Buffer): Promise<ScanVerdict>;
  isReachable(): Promise<boolean>;
}

/** clamd injoignable, délai dépassé ou réponse d'erreur : le fichier n'est ni accepté ni rejeté. */
export class AntivirusUnavailableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`Antivirus indisponible : ${reason}.`, options);
    this.name = 'AntivirusUnavailableError';
  }
}

export interface ClamdSettings {
  readonly host: string;
  readonly port: number;
  /** Délai global d'une analyse (docs/13 D5 : 30 s). */
  readonly timeoutMs?: number;
  /** Taille des morceaux INSTREAM (doit rester sous `StreamMaxLength` de clamd pour le total). */
  readonly chunkBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const CLEAN_REPLY = /^stream: OK$/;
const INFECTED_REPLY = /^stream: (.+) FOUND$/;

/**
 * Client clamd (protocole INSTREAM sur TCP) : le contenu en clair est transmis en morceaux préfixés par leur taille,
 * terminé par un morceau vide ; clamd répond `stream: OK` ou `stream: <signature> FOUND`.
 */
export class ClamdScanner implements Antivirus {
  readonly enabled = true;
  private readonly timeoutMs: number;
  private readonly chunkBytes: number;

  constructor(private readonly settings: ClamdSettings) {
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.chunkBytes = settings.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  }

  async scan(content: Buffer): Promise<ScanVerdict> {
    const reply = await this.exchange(this.instreamFrames(content), this.timeoutMs);
    if (CLEAN_REPLY.test(reply)) return { status: 'clean' };
    const infected = INFECTED_REPLY.exec(reply);
    if (infected?.[1]) return { status: 'infected', signature: infected[1] };
    throw new AntivirusUnavailableError('réponse inattendue de clamd');
  }

  async isReachable(): Promise<boolean> {
    try {
      return (await this.exchange([Buffer.from('zPING\0')], PROBE_TIMEOUT_MS)) === 'PONG';
    } catch {
      return false;
    }
  }

  private instreamFrames(content: Buffer): Buffer[] {
    const frames: Buffer[] = [Buffer.from('zINSTREAM\0')];
    for (let offset = 0; offset < content.length; offset += this.chunkBytes) {
      const chunk = content.subarray(offset, offset + this.chunkBytes);
      const size = Buffer.alloc(4);
      size.writeUInt32BE(chunk.length, 0);
      frames.push(size, chunk);
    }
    frames.push(Buffer.alloc(4));
    return frames;
  }

  /** Envoie les trames et renvoie la réponse de clamd (terminée par `\0`), sans le terminateur. */
  private exchange(frames: readonly Buffer[], timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = connect({ host: this.settings.host, port: this.settings.port });
      const received: Buffer[] = [];
      let settled = false;
      const finish = (error: Error | undefined, reply?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(reply ?? '');
      };
      const timer = setTimeout(() => finish(new AntivirusUnavailableError('délai dépassé')), timeoutMs);
      socket.on('connect', () => {
        for (const frame of frames) socket.write(frame);
      });
      socket.on('data', (data: Buffer) => {
        received.push(data);
        const reply = Buffer.concat(received);
        const end = reply.indexOf(0);
        if (end >= 0) finish(undefined, reply.subarray(0, end).toString('utf8').trim());
      });
      socket.on('error', (cause) => finish(new AntivirusUnavailableError('connexion impossible', { cause })));
      socket.on('close', () => finish(new AntivirusUnavailableError('connexion fermée sans réponse')));
    });
  }
}

/** Hors production sans `CLAMAV_HOST` : analyse ignorée (avertissement au démarrage, docs/13 §8). Interdit en production. */
export class DisabledAntivirus implements Antivirus {
  readonly enabled = false;

  scan(): Promise<ScanVerdict> {
    return Promise.resolve({ status: 'clean' });
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
