import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: ['.next/**', 'coverage/**', 'next-env.d.ts'] },
  {
    rules: {
      'no-console': 'error',
      // CSP stricte (docs/11 D14) : un attribut `style` ou du HTML injecté serait bloqué ou ouvrirait une brèche XSS.
      'react/forbid-dom-props': ['error', { forbid: ['style'] }],
      'react/no-danger': 'error',
    },
  },
];

export default config;
