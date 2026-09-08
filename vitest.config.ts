import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // The `?fbEmulator=...` query param is what firebaseClient.ts's
    // signInForTesting() gates on (a safety net so it's inert in a real,
    // deployed build) — tests run entirely against the fakes in
    // src/test/, never a real network, so it's harmless to leave "on" for
    // the whole suite rather than threading it through every test.
    environmentOptions: {
      jsdom: { url: 'http://localhost/?fbEmulator=fake:0:0' },
    },
  },
})
