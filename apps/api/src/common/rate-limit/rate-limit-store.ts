/** Résultat d'un coup porté à une fenêtre fixe (limiteur par IP, par compte, par jeton). */
export interface WindowHit {
  readonly totalHits: number;
  /** Temps restant avant la fin de la fenêtre. */
  readonly timeToExpireMs: number;
  readonly isBlocked: boolean;
  /** Temps restant du blocage (0 si non bloqué). */
  readonly timeToBlockExpireMs: number;
}

/** Échecs consécutifs d'un identifiant (délai progressif) : nombre et date du dernier. */
export interface FailureRecord {
  readonly count: number;
  readonly lastAtMs: number;
}

/** Résultat de l'admission d'une tentative de connexion (délai progressif). */
export interface AttemptGate {
  readonly allowed: boolean;
  /** Attente restante avant la prochaine tentative examinée (0 si admise). */
  readonly retryAfterMs: number;
  /** Nombre d'échecs pris en compte, tentative admise comprise. */
  readonly count: number;
}

/**
 * Stockage de la limitation de débit (docs/11 D2) : le même contrat sert le limiteur HTTP (fenêtres fixes)
 * et le délai progressif de connexion (compteur d'échecs à expiration glissante).
 */
export interface RateLimitStore {
  /**
   * Compte un coup. Le (`limit` + 1)-ième coup de la fenêtre est refusé et déclenche un blocage de `blockMs`
   * (0 : refus tant que la fenêtre est pleine, sans blocage prolongé).
   */
  hit(key: string, ttlMs: number, limit: number, blockMs: number): Promise<WindowHit>;
  /** Incrémente le compteur d'échecs, date le dernier échec et prolonge l'expiration de `ttlMs`. */
  recordFailure(key: string, ttlMs: number, nowMs: number): Promise<FailureRecord>;
  /**
   * ATOMIQUE : décide si une tentative est examinée et, si oui, la compte aussitôt comme un échec (réservation) ; une connexion
   * réussie la libère (`reset`/`release`). Deux tentatives parallèles ne peuvent donc pas franchir le même palier.
   * `scheduleSeconds[n-1]` est le délai après le n-ième échec ; `capSeconds` plafonne ce délai (réseau de confiance).
   */
  gate(key: string, ttlMs: number, nowMs: number, scheduleSeconds: readonly number[], capSeconds: number | null): Promise<AttemptGate>;
  /**
   * Retire l'échec réservé par le dernier `gate` admis et restaure la date de l'échec précédent : une réservation rendue
   * (mot de passe juste devant un second facteur) ne relance pas le délai. L'échec éventuel du code le recomptera.
   */
  release(key: string): Promise<void>;
  get(key: string): Promise<FailureRecord | null>;
  reset(key: string): Promise<void>;
}
