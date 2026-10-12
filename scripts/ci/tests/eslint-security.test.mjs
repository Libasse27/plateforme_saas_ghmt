// Prouve que les règles de sécurité ESLint (docs/13 §1.2, §11.1 point 5) se déclenchent sur un code fautif,
// dans apps/api ET packages/shared. Lancement : node --test scripts/ci/tests/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const racine = resolve(import.meta.dirname, '../../..');
const paquets = ['apps/api', 'packages/shared'];

/** Charge ESLint depuis le paquet (chaque paquet porte sa propre dépendance) et lint un texte virtuel situé dans `src/`. */
async function lint(paquet, code) {
  const dossier = resolve(racine, paquet);
  const { ESLint } = createRequire(resolve(dossier, 'package.json'))('eslint');
  const eslint = new ESLint({ cwd: dossier });
  const [resultat] = await eslint.lintText(code, { filePath: resolve(dossier, 'src/__fixture-lint__.ts') });
  return resultat.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

const fautifs = {
  '$queryRawUnsafe (appel)': ['no-restricted-properties', 'export const f = (tx: any) => tx.$queryRawUnsafe(`SELECT ${1}`);'],
  '$executeRawUnsafe (appel)': ['no-restricted-properties', "export const f = (tx: any) => tx.$executeRawUnsafe('DELETE FROM t');"],
  '$queryRawUnsafe (accès calculé)': ['no-restricted-properties', "export const f = (tx: any) => tx['$queryRawUnsafe']('x');"],
  '$executeRawUnsafe (déstructuration)': ['no-restricted-properties', 'export const f = (tx: any) => { const { $executeRawUnsafe } = tx; return $executeRawUnsafe; };'],
  eval: ['no-eval', "export const f = (s: string) => eval(s);"],
  'new Function': ['no-new-func', "export const f = new Function('a', 'return a');"],
  'Function()': ['no-new-func', "export const f = Function('return 1');"],
  'setTimeout avec une chaîne': ['no-implied-eval', "setTimeout('alert(1)', 10);"],
};

for (const paquet of paquets) {
  describe(`règles de sécurité ESLint : ${paquet}`, () => {
    for (const [cas, [regle, code]] of Object.entries(fautifs)) {
      it(`signale ${cas} (${regle})`, async () => {
        const regles = await lint(paquet, code);
        assert.ok(regles.includes(regle), `règle ${regle} attendue, obtenu : ${JSON.stringify(regles)}`);
      });
    }

    it('accepte les requêtes paramétrées ($queryRaw balisé)', async () => {
      const regles = await lint(paquet, 'export const f = (tx: any, id: string) => tx.$queryRaw`SELECT 1 WHERE id = ${id}`;\n');
      assert.deepEqual(regles.filter((r) => ['no-restricted-properties', 'no-eval', 'no-new-func'].includes(r)), []);
    });
  });
}
