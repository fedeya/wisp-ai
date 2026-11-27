import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

// @effect/vitest registers tests as `it.effect(...)`, `it.live(...)` and their
// modifiers. Test-block rules only know plain `it`/`test`, so list every form
// that takes a test body; `layer(...)` and `it.layer(...)` take suite bodies.
const effectTestModifiers = ['', '.skip', '.only', '.fails', '.skipIf', '.runIf', '.each', '.prop'];
const effectTestBlockFunctions = [
  ...['it.effect', 'it.live'].flatMap((tester) =>
    effectTestModifiers.map((modifier) => `${tester}${modifier}`),
  ),
  'it.prop',
];

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    '**/.next/**',
    '**/.vercel/**',
    'runtime/**',
    'dist/**',
    '**/.eve/**',
    '**/src-tauri/**',
    '**/dist/**',
    '**/.output/**',
  ],
  categories: {
    correctness: 'error',
  },
  rules: {
    curly: ['error', 'multi-line'],
    'no-var': 'error',
    'vitest/no-standalone-expect': [
      'error',
      { additionalTestBlockFunctions: effectTestBlockFunctions },
    ],
  },
  overrides: [
    {
      files: ['apps/agent/**', 'apps/desktop/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: ['@wisp/server', '@wisp/server/*'],
          },
        ],
      },
    },
    {
      files: ['packages/protocol/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              '@wisp/server',
              '@wisp/server/*',
              '@wisp/agent',
              '@wisp/agent/*',
              '@wisp/desktop',
              '@wisp/desktop/*',
            ],
          },
        ],
      },
    },
    {
      // Migration baseline: preset rules Wisp does not pass yet, with the number
      // of findings each had. They warn, so new code sees them without failing
      // lint; each becomes an error once its findings are fixed, or is turned
      // off with a reason.
      files: ['**/*'],
      rules: {
        '@nkzw/no-instanceof': 'warn', // 5
        'array-callback-return': 'warn', // 1
        'import/consistent-type-specifier-style': 'warn', // 184
        'import/no-namespace': 'warn', // 1
        'jsx-a11y/control-has-associated-label': 'warn', // 1
        'jsx-a11y/label-has-associated-control': 'warn', // 1
        'jsx-a11y/no-noninteractive-tabindex': 'warn', // 3
        'jsx-a11y/prefer-tag-over-role': 'warn', // 24
        'no-console': 'warn', // 45
        'no-empty': 'warn', // 3
        'no-promise-executor-return': 'warn', // 41
        'object-shorthand': 'warn', // 16
        'prefer-const': 'warn', // 2
        'preserve-caught-error': 'warn', // 1
        'promise/no-callback-in-promise': 'warn', // 4
        'quality/no-array-filter-map': 'warn', // 12
        'quality/no-chained-type-assertions': 'warn', // 38
        'quality/no-conditional-empty-object-spread': 'warn', // 49
        'quality/no-known-value-widening': 'warn', // 50
        'quality/no-object-parameters': 'warn', // 3
        'quality/no-reflect-apply': 'warn', // 1
        'quality/no-unknown-returns': 'warn', // 23
        'quality/no-unsafe-dictionary-type': 'warn', // 82
        'react/button-has-type': 'warn', // 1
        'react/exhaustive-deps': 'warn', // 1
        'react/set-state-in-effect': 'warn', // 1
        'typescript/array-type': 'warn', // 403
        'typescript/await-thenable': 'warn', // 141
        'typescript/consistent-type-imports': 'warn', // 11
        'typescript/no-base-to-string': 'warn', // 46
        'typescript/no-empty-object-type': 'warn', // 2
        'typescript/no-explicit-any': 'warn', // 12
        'typescript/no-floating-promises': 'warn', // 2
        'typescript/no-meaningless-void-operator': 'warn', // 5
        'typescript/no-misused-promises': 'warn', // 45
        'typescript/no-misused-spread': 'warn', // 2
        'typescript/no-non-null-assertion': 'warn', // 132
        'typescript/no-redundant-type-constituents': 'warn', // 1
        'typescript/no-unnecessary-type-assertion': 'warn', // 193
        'typescript/no-unsafe-argument': 'warn', // 37
        'typescript/no-unsafe-assignment': 'warn', // 157
        'typescript/no-unsafe-call': 'warn', // 213
        'typescript/no-unsafe-member-access': 'warn', // 227
        'typescript/no-unsafe-return': 'warn', // 63
        'typescript/no-unsafe-type-assertion': 'warn', // 325
        'typescript/only-throw-error': 'warn', // 1
        'typescript/require-array-sort-compare': 'warn', // 10
        'typescript/switch-exhaustiveness-check': 'warn', // 1
        'typescript/unbound-method': 'warn', // 11
        'typescript/use-unknown-in-catch-callback-variable': 'warn', // 29
        'unicorn/catch-error-name': 'warn', // 13
        'unicorn/consistent-function-scoping': 'warn', // 38
        'unicorn/no-array-fill-with-reference-type': 'warn', // 5
        'unicorn/no-hex-escape': 'warn', // 17
        'unicorn/no-useless-promise-resolve-reject': 'warn', // 1
        'unicorn/numeric-separators-style': 'warn', // 385
        'unicorn/prefer-at': 'warn', // 1
        'unicorn/prefer-dom-node-append': 'warn', // 1
        'unicorn/prefer-import-meta-properties': 'warn', // 4
        'unicorn/prefer-number-properties': 'warn', // 1
        'unicorn/prefer-set-has': 'warn', // 1
        'unicorn/prefer-single-call': 'warn', // 3
        'unicorn/prefer-string-raw': 'warn', // 55
        'unicorn/prefer-string-replace-all': 'warn', // 54
        'unicorn/prefer-structured-clone': 'warn', // 7
        'unicorn/prefer-top-level-await': 'warn', // 4
        'vitest/expect-expect': [
          'warn',
          { additionalTestBlockFunctions: effectTestBlockFunctions },
        ], // 29
        'vitest/no-conditional-expect': 'warn', // 18
        'vitest/require-mock-type-parameters': 'warn', // 154
        'vitest/require-to-throw-message': 'warn', // 45
        'vitest/valid-expect': 'warn', // 23
        'vitest/valid-title': 'warn', // 1
      },
    },
  ],
});
