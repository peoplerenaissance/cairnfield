// The bindings that only the tests have. The Vitest config reads both in Node: the
// migrations of `migrations/`, which each test file applies to its local database, and
// the files of the demo fixtures that a test serves, as text, by their path under `fixtures/`.

declare namespace Cloudflare {
  interface Env {
    readonly MIGRATIONS: import("cloudflare:test").D1Migration[];
    readonly FIXTURES: { readonly [path: string]: string };
  }
}
