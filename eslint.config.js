// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Luật thuần cho engine (SPEC 3.1, 4.10 thuộc tính 6):
 * không đọc đồng hồ, không số ngẫu nhiên, không mạng, không CSDL.
 */
const enginePurity = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      message: 'Engine là hàm thuần: nhận `now` từ tham số, không gọi Date.now().',
    },
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: 'Engine là hàm thuần: không dùng new Date() không tham số.',
    },
    {
      selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
      message: 'Engine là hàm thuần: không dùng Math.random().',
    },
    {
      selector: "CallExpression[callee.object.name='crypto'][callee.property.name=/^(randomUUID|getRandomValues)$/]",
      message: 'Engine là hàm thuần: không sinh số ngẫu nhiên.',
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'fetch', message: 'Engine không gọi mạng.' },
    { name: 'XMLHttpRequest', message: 'Engine không gọi mạng.' },
    { name: 'WebSocket', message: 'Engine không gọi mạng.' },
    { name: 'setTimeout', message: 'Engine không hẹn giờ; trả effect schedule_timer.' },
    { name: 'setInterval', message: 'Engine không hẹn giờ; trả effect schedule_timer.' },
    { name: 'process', message: 'Engine không đọc môi trường.' },
  ],
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['node:*', 'fs', 'net', 'http', 'https', 'dns', 'child_process', 'pg', 'pg-*', 'drizzle-orm', 'drizzle-orm/*', 'undici', 'ws', '@mihato/backend', '@mihato/providers'],
          message: 'Engine là thư viện thuần: không I/O, không mạng, không CSDL.',
        },
      ],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.gen.ts',
      'apps/*/ios/**',
      'apps/*/android/**',
      'packages/workflow-engine/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['packages/workflow-engine/src/**/*.ts', 'packages/domain/src/calendar/**/*.ts'],
    rules: enginePurity,
  },
  {
    files: ['**/*.cjs', '**/metro.config.js', '**/babel.config.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
