// ESLint de l'API (docs/13 §1.2, §11.1 point 5) : configuration plate, typescript-eslint sans typage (comme apps/web).
// Les règles de sécurité sont prouvées par scripts/ci/tests/eslint-security.test.mjs.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Appels Prisma qui concatènent du SQL : seules les requêtes balisées ($queryRaw`…`, Prisma.sql) sont paramétrées. */
const prismaUnsafe = ['$queryRawUnsafe', '$executeRawUnsafe'].map((property) => ({
  property,
  message: `${property} est interdit (injection SQL) : utiliser la requête balisée ${property.replace('Unsafe', '')}\`…\` ou Prisma.sql.`,
}));

/** Paramètre imposé par une interface, ou propriété retirée par déstructuration : préfixe `_` explicite. */
const unusedVars = { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true };

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Racine explicite : plusieurs tsconfig coexistent dans le monorepo.
      parserOptions: { tsconfigRootDir: import.meta.dirname },
      // Minuteurs déclarés pour que no-implied-eval détecte `setTimeout('code')`.
      globals: { setTimeout: 'readonly', setInterval: 'readonly', setImmediate: 'readonly' },
    },
    rules: {
      // Sécurité : SQL brut non paramétré et évaluation dynamique de code.
      'no-restricted-properties': ['error', ...prismaUnsafe],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-unused-vars': ['error', unusedVars],
    },
  },
  {
    // Tests (les fichiers de test n'appartiennent pas à l'équipe CI, docs/13 §10) :
    // - `any` sur les corps de réponse HTTP et variables inutilisées, sans enjeu de sécurité (avertissement seulement) ;
    // - SQL brut constant des sondes de privilèges et d'isolation (db-isolation, review-payments, purge-last-seen…), jamais
    //   alimenté par une entrée externe. `eval` et `new Function` restent des erreurs.
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', unusedVars],
    },
  },
);
