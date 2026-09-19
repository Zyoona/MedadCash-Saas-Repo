import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'prisma/**/*.ts'],
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
