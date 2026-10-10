// The one binding that only the tests have: the migrations of `migrations/`, which the
// Vitest config reads and each test file applies to its local database.

declare namespace Cloudflare {
  interface Env {
    readonly MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
