import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Repo maintenance scripts are plain Node programs, not library code, so
    // they need the Node globals that the TypeScript sources get from tsc.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      'bin/',
      'docs/.vitepress/dist/',
      'docs/.vitepress/cache/',
    ],
  },
);
