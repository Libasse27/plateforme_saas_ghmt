// ESLint du paquet partagé (docs/13 §1.2, §11.1 point 5) : configuration plate, typescript-eslint sans typage (comme apps/web).
// Mêmes règles de sécurité que apps/api, prouvées par scripts/ci/tests/eslint-security.test.mjs.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Appels Prisma qui concatènent du SQL : seules les requêtes balisées ($queryRaw`…`, Prisma.sql) sont paramétrées. */
const prismaUnsafe = ['$queryRawUnsafe', '$executeRawUnsafe'].map((property) => ({
  property,
  message: `${property} est interdit (injection SQL) : utiliser la requête balisée ${property.replace('Unsafe', '')}\`…\` ou Prisma.sql.`,
}));

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
);
