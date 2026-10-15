# Migration validation

## Automated checks

- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm test`: 84 passed, zero skipped or failed.
- Documentation site production build: passed.
- TypeScript and checked-in JavaScript CLI entrypoints synchronized by build.

Migration tests cover read-only planning, source-change detection, occupied destinations, collisions, rollback after a write failure, binary preservation, config flattening, functions/dynamic spreads, renamed/default barrel imports, multiline export barrels, Sass partial namespaces and generated DI execution. DI dependencies are shared within one register invocation and isolated between invocations; this does not replace the kit's own SSR lifecycle tests.

## Legacy project rehearsal

Executed only on a temporary copy of one-c-library-frontend. Production sources were not modified; environment files were not copied. Dependencies were reused through per-entry links, with build caches kept in the temporary project.

- 1,579 legacy files classified and moved or archived.
- 200 review items in the generated report (including archived legacy providers/barrels and architecture dependencies, not 200 compiler errors).
- Zero provider conversion errors.
- SvelteKit sync passed.
- Svelte check: 31 errors in 18 files, zero warnings.

Five errors are missing PUBLIC\_\* declarations because environment files were intentionally omitted. Remaining errors concern conflicting Appeals models, their consumers, and the unsupported legacy application/utils location. No generated DI or Sass import errors were reported. This is not a clean application build or a runtime acceptance test.

Different source files converging on the same target are all archived, never silently overwritten. Decide how to reconcile Appeals models and where application/utils belongs, restore appropriate files from .backup, and update affected imports. Review cross-context/workspace dependencies separately: a successful structural move does not establish valid business boundaries.

## Running safely

Commit or independently back up current work, then use `azure-net migrate --dry-run` before `azure-net migrate`. The generated .azure-net/migrations/migration-\*/Report.md links actual destination files and lists reasons for manual intervention. Original bytes and a manifest are stored alongside it. These snapshots may contain sensitive source code and should remain private.

After resolving report items, run `azure-net check internal`, the project's typecheck and build, and exercise application routes. Migration does not upgrade arbitrary kit API usage or execute project build scripts automatically.
