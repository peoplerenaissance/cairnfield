// The bindings that only the tests have. The Vitest config reads all four in Node: the
// migrations of `migrations/`, which each test file applies to its local database, the
// files of the demo fixtures that a test serves, as text, by their path under `fixtures/`,
// the files of the page by the names the build gives them, and the source of the page's
// scripts by their file names in `src/page/`.

declare namespace Cloudflare {
  interface Env {
    readonly MIGRATIONS: import("cloudflare:test").D1Migration[];
    readonly FIXTURES: { readonly [path: string]: string };
    readonly PAGE_FILES: { readonly [name: string]: string };
    readonly PAGE_SCRIPTS: { readonly [name: string]: string };
  }
}
