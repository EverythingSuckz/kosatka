//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  ...tanstackConfig,
  {
    rules: {
      // pnpm catalog enforcement does not apply. this project uses bun.
      'pnpm/json-enforce-catalog': 'off',
    },
  },
  {
    ignores: [
      'eslint.config.js',
      'prettier.config.js',
      'scripts/**',
      'dist/**',
      'samples/**',
      'tmp/**',
      // wrangler dev/deploy scratch, holds generated worker bundles
      '.wrangler/**',
    ],
  },
]
