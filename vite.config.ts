import { defineConfig } from 'vitest/config'

// GitHub Pages serves the site under /<repo-name>/. Keep this in sync with the
// repository name (there is no git remote yet, so this is the folder name).
export default defineConfig({
  base: '/saitenhieb-setlist/',
  build: { target: 'es2020' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
