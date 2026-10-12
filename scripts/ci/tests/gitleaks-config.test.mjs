// La configuration .gitleaks.toml (docs/13 §11.1 point 3) bloque un secret factice et n'exclut que les valeurs documentées.
// Exécute l'image gitleaks épinglée de security.yml (Docker requis ; ignoré sinon). Les faux secrets sont tirés au hasard
// à l'exécution : ce fichier n'en contient aucun.
// Lancement : node --test 'scripts/ci/tests/*.test.mjs'
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const racine = resolve(import.meta.dirname, '../../..');
const workflow = readFileSync(resolve(racine, '.github/workflows/security.yml'), 'utf8');
const image = /(ghcr\.io\/gitleaks\/gitleaks:v[\d.]+@sha256:[0-9a-f]{64})/.exec(workflow)?.[1];
const sansDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0 && 'Docker indisponible';

/** Jeton d'apparence aléatoire (forte entropie), différent à chaque exécution. */
const jeton = (longueur) => randomBytes(longueur).toString('base64url').slice(0, longueur);

/**
 * Écrit les fichiers dans un dossier jetable, les transmet au conteneur par une archive sur l'entrée standard (aucun
 * montage : le démon Docker ne voit pas forcément le /tmp local) et renvoie les règles et fichiers signalés par gitleaks.
 */
function analyser(fichiers) {
  const dossier = mkdtempSync(join(tmpdir(), 'ghmt-ci-gitleaks-'));
  for (const [chemin, contenu] of Object.entries({ ...fichiers, '.config.toml': readFileSync(resolve(racine, '.gitleaks.toml')) })) {
    mkdirSync(dirname(join(dossier, chemin)), { recursive: true });
    writeFileSync(join(dossier, chemin), contenu);
  }
  const archive = spawnSync('tar', ['-c', '-C', dossier, '.']).stdout;
  const commande = 'mkdir /scan && tar -x -C /scan && mv /scan/.config.toml /config.toml && '
    + 'gitleaks dir /scan --config /config.toml --no-banner --redact --report-format json --report-path /tmp/rapport.json; '
    + 'code=$?; cat /tmp/rapport.json; exit $code';
  const resultat = spawnSync('docker', ['run', '--rm', '-i', '--entrypoint', 'sh', image, '-c', commande], { input: archive, encoding: 'utf8' });
  assert.ok([0, 1].includes(resultat.status), `gitleaks en erreur : ${resultat.stderr}`);
  return JSON.parse(resultat.stdout || '[]').map((f) => `${f.RuleID}:${f.File.replace('/scan/', '')}`);
}

describe('.gitleaks.toml', { skip: sansDocker }, () => {
  it('security.yml épingle l\'image gitleaks par digest', () => {
    assert.ok(image, 'image gitleaks épinglée introuvable dans security.yml');
  });

  it('signale un secret factice dans le code applicatif', () => {
    const signales = analyser({ 'apps/api/src/config.ts': `export const apiKey = '${jeton(40)}';\n` });
    assert.ok(signales.some((s) => s.endsWith('apps/api/src/config.ts')), JSON.stringify(signales));
  });

  it('signale un jeton GitHub et une clé privée, même dans un fichier de test', () => {
    const signales = analyser({
      'apps/api/test/a.e2e-spec.ts': `const t = 'ghp_${jeton(36).replace(/[-_]/g, 'a')}';\n`,
      'apps/web/src/b.test.ts': `const k = \`-----BEGIN RSA PRIVATE KEY-----\n${jeton(64)}\n${jeton(64)}\n-----END RSA PRIVATE KEY-----\`;\n`,
    });
    assert.ok(signales.some((s) => s.endsWith('a.e2e-spec.ts')), JSON.stringify(signales));
    assert.ok(signales.some((s) => s.endsWith('b.test.ts')), JSON.stringify(signales));
  });

  it('exclut les mots de passe génériques des tests et les exemples de docs/03-api.md', () => {
    const signales = analyser({
      'apps/api/test/c.e2e-spec.ts': `const newPassword = '${jeton(24)}';\n`,
      'apps/web/src/d.test.ts': `const refreshToken = '${jeton(32)}';\n`,
      'docs/03-api.md': `{ "accessToken": "${jeton(40)}" }\n`,
    });
    assert.deepEqual(signales, []);
  });

  it('exclut les identifiants de développement documentés (pile infra/docker-compose.yml)', () => {
    const signales = analyser({
      'infra/docker-compose.yml': 'secretKey: "ghmt-dev-s3-secret"\nPOSTGRES_PASSWORD: ghmt_dev_only\n',
      'scripts/ci/generate-env-test.mjs': "const r = 'ghmt_migrator:ghmt_migrator_dev';\n",
    });
    assert.deepEqual(signales, []);
  });
});
