# @azure-net/cli

CLI installs separately: `npm i -D @azure-net/cli`. Requires Node >=22.15 and @azure-net/kit >=6.0.0-next.1.

## Architecture (breaking change)

```text
src/app/
  Contexts/
    SharedKernel/
    Orders/
      Domain/{Entities,Ports,Enums}
      Infrastructure/Repositories
      Application/UseCases
  Presentation/
    Admin/{Ui,Scopes,Shell}
    Public/{Ui,Scopes,Shell}
    Shared/{Ui,Scopes,Shell}
  Platform/
    Foundation/{Datasource,Response,Schema,DI}
    Bootstrap/{Routes,Localization}
```

Each context, including SharedKernel, has the three context layers. Without configured workspaces, Presentation contains Ui, Scopes and Shell directly. Ui components go into Components/Shared, Components/Layout or Components/Page/PageName; widgets into Widgets and design components into Design. Presenters go into Scopes/ScopeName.

Application directories/files use PascalCase; barrel index.ts is the exception. Framework files outside app retain their native names, including src/program.ts. Aliases are `#contexts`, `#presentation`, `#platform`.

Contexts cannot import other contexts, except SharedKernel. SharedKernel cannot import other contexts. Presentation can import contexts. Workspaces cannot import each other except Shared; Shared cannot import other workspaces. These are static architectural checks, not a security sandbox: computed imports and indirect re-export graphs are not exhaustively resolved.

Old contexts/sharedAlias/coreAlias configuration no longer determines generation paths. Existing projects are NOT migrated or deleted automatically. Move old code and imports deliberately before running the new checks.

## Configuration

```ts
export default {
	presentationWorkspaces: ['Admin', 'Public'],
	packageManager: 'pnpm',
	runChecksBeforePush: true
};
```

Workspaces configure initial structure only; subsequent selections discover directories on disk. Context selectors offer existing contexts or creation of a new one. SharedKernel and, for grouped presentation, Shared are initialized automatically. The default schema factory can be selected through defaultSchemaFactory. Presenters are classes registered with RegisterProvider; no presenter factory is generated.

### Presenter Generation

`generate presenter`, `generate module` and `generate module-preset` generate a
class accepting the selected UseCases in its constructor. Only the async helpers
needed by its methods are imported directly from `@azure-net/kit/delivery`.
Schema generation and provider service-key selection remain unchanged.

Each file exports both `OrdersPresenter` and `useOrdersPresenter`. The accessor
is registered with `RegisterProvider(() => new OrdersPresenter(...), 'scoped')`;
dependencies are resolved through `ApplicationProvider()` inside that callback.
Call the accessor in the component. Generated arrow methods support destructuring.
There is no `create presenter-factory` command or fresh-install presenter-factory step.

`migrate --dry-run` also previews this API upgrade for projects already using the
Contexts/Presentation/Platform layout. Recognized callback presenters become
classes plus accessors. The migrator preserves lexical state through a private
state object and rewrites named consumer imports/re-exports to the accessor,
retaining their local aliases. Async-helper factories are replaced by direct
function references, preserving explicit custom error types. Unsupported custom
unresolved injections and dynamic consumer imports are listed in the migration report for
manual review. Original files remain in the migration snapshot.

`scoped` means request-cached on the server and new-per-call in the browser, not
component-context caching. `singleton` shares only on the client (still scoped to
the request on the server). `transient`/`trancient` always creates a new instance.
No effect cleanup or hydration is performed by the registration.

## Initialization and Foundation

| Command                                | Purpose                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| `azure-net init folders-structure`     | Initialize architecture and Svelte aliases, preserve existing files |
| `azure-net init edges`                 | Configure AzureNetPlugin in Vite (historical command name)          |
| `azure-net install fresh`              | Structure, plugin, program.ts and optional Foundation artifacts     |
| `azure-net create schema-factory`      | Foundation/Schema                                                   |
| `azure-net create schema-rule`         | Foundation/Schema/CustomRules                                       |
| `azure-net create response`            | Foundation/Response                                                 |
| `azure-net create datasource`          | Foundation/Datasource                                               |
| `azure-net create translation-manager` | Bootstrap/Localization                                              |

DI is centralized in Platform/Foundation/DI/ApplicationProvider.ts. Register repository/use-case factories there before presenter generation. The generator reads the actual returned service key (e.g. Orders), not a guessed context provider name. Module generation pauses for manual DI registration; it does not invent datasource configuration or edit user DI logic.

## Generation

| Command after `azure-net generate` | Result                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| `domain`                           | Interfaces in the context's Domain/Entities and Ports               |
| `repo` / `repository`              | Repository, contract in Ports, optional UseCases                    |
| `repository-method`                | Add a method and update the contract/UseCases                       |
| `use-cases`                        | ClassMirror-based wrapper for an existing repository                |
| `presenter`                        | Choose workspace/scope; use central ApplicationProvider             |
| `module`                           | Domain, repository, UseCases, manual DI confirmation, presenter     |
| `module-preset`                    | Predefined CRUD types/methods, UseCases, DI confirmation, presenter |
| `component`                        | Ui/Components with Shared/Layout/Page selection                     |
| `widget`                           | Ui/Widgets                                                          |
| `design-component`                 | Ui/Design                                                           |
| `types-json`                       | Add inferred fields to an existing entity interface                 |
| `schema-from-type`                 | Populate schema rules from interface fields                         |
| `routes`                           | Overwrite Platform/Bootstrap/Routes/index.ts                        |

Interface declarations retain I; filenames omit it (IOrdersRepository in OrdersRepository.ts). Existing artifacts are not silently replaced; barrel exports are appended. Routes are the intentional overwrite exception: do not hand-edit their generated index.ts.

Routes support ungrouped arrays, root route-group arrays, or groupRoutesFunc in config. The callback receives url, relativeDir, segments, dynamicParams, rootGroup, groupStack, depth, hasChildren, hasPage and hasServer; return a group name. Groups are exported variables, not a generated group object. Optional route segments produce both variants. Current template output uses `{param}`; rest-parameter semantics and Svelte encoded literal segments require additional handling before treating this as a complete Svelte route matcher.

## Git workflow

`azure-net add commit-tools` installs NO packages. It backs up previous Prettier settings under .azure-net/PrettierBackups and replaces the configuration. Existing dependencies/scripts are not removed; install needed formatter tooling yourself.

`azure-net commit` commits staged changes only. Choose a type, enter a nonempty subject of at most 100 characters, optionally enter body, breaking changes and footer. Format is `feat(emoji): subject` (a breaking commit adds !).

`azure-net push` runs project checks, stages with `git add .`, prompts for the commit, commits, then pushes. A failed step stops the sequence. Missing runChecksBeforePush means true; false or `--no-check` skips checks. Review your changes and .gitignore first: git add . intentionally stages all unignored changes. These commands do not set up Husky or install commitlint, semantic-release or git-cz.

## Checks

Individual checks: presenter-names, provider-names, provider-graph, domain, imports, hooks, layer-imports, layer-boundaries, folders-structure.

`azure-net check internal` runs all checks. `azure-net check project` runs packageManager run format, internal, packageManager run lint and packageManager run check sequentially. Format can modify files. User hooks.server/hooks.client are forbidden; use program.ts and AzureNetPlugin.

## Manual acceptance checklist

1. In a disposable project, initialize flat Presentation; repeat with Admin/Public workspaces.
2. Generate a domain/repo in Orders. Verify Entities/Ports, filenames, imports and contracts.
3. Register UseCases in central DI; create an Admin/Scopes/Orders presenter and schemas.
4. Generate module-preset, UI artifacts, translations and routes. Repeat routes to verify overwrite.
5. Introduce a cross-context import and an Admin-to-Public import: internal must fail. Imports from SharedKernel/Shared must pass.
6. Verify schema-from-type, types-json and repository-method on existing generated artifacts.
7. Test commit/push only in a disposable Git repository with a test remote. Exercise failing checks and --no-check.

## Development

`pnpm typecheck`, `pnpm lint`, `pnpm test`. Build synchronizes TypeScript into the checked-in JavaScript used by bin/azure-net.js. Always build before packing. Tests compile generated modules against the adjacent built kit when available.

## Migrate a legacy project

```bash
azure-net migrate --dry-run
azure-net migrate
# Non-interactive apply, after reviewing the plan:
azure-net migrate --yes
```

Run from the project root. Dry-run does not write files. Apply requires confirmation (or --yes), rejects occupied targets and detects source changes since planning. Commit or otherwise back up your work first.

Legacy application areas become Presentation workspaces; domain subfolders become Contexts. Repositories and UseCases are matched by name, including legacy singular UseCase filenames. UI and presentation move into Ui and Scopes. Foundation constructs move into Platform/Foundation, runtime into Bootstrap. Shared presentation becomes Shared. Ambiguous/colliding files are preserved byte-for-byte in src/app/.backup with their original hierarchy. The CLI never silently chooses a winner or automatically merges distinct domain models.

Static imports/re-exports, literal dynamic imports, Svelte script imports and local stylesheet/asset references are rewritten. Named/default barrel exports are followed. Dynamic import expressions and glob patterns require review. Shared business dependencies that would violate new context boundaries are reported; the migration does not invent domain boundaries or move arbitrary types into SharedKernel to hide violations.

Supported declarative legacy providers are consolidated into a single Foundation/DI/ApplicationProvider.ts. Datasource construction stays inside register, HTTP/cookie callbacks are retained, repository sharing is retained with private lazy getters. There are no separate datasource/infrastructure providers. Custom register blocks, boot hooks, unsupported provider logic and duplicate service keys require manual review; original provider files are archived. Structural migration is not an automatic kit API upgrade.

Full originals of changed/removed files and a manifest are saved under .azure-net/migrations/migration-\*/original. Report.md links relocated/archived files and explains review items. Write failures restore original contents. Obsolete source directories are removed only after their files have been written to their destinations. .backup is ignored by CLI checks and excluded in tsconfig; inspect it before deciding what to retain. Keep migration snapshots private, since original source may contain sensitive configuration.

Afterwards run check internal, your project's typecheck and build. These can still fail on ambiguous files, old APIs and genuine new architecture violations; the report is the handoff for manual resolution. Repeating migrate on an already migrated tree stops without changing it.

The datasource-provider creation command has been removed, including its fresh-install prompt. Configure datasource options in ApplicationProvider.register instead.

## Package subpath imports (SvelteKit 3)

Generation uses `#contexts`, `#presentation` and `#platform`. Initialization and migration merge mappings into `package.json#imports`, preserving unrelated package fields and custom imports. Conflicting reserved mappings cause an error rather than being overwritten. No aliases are added to Vite or Svelte config. Fresh install still configures AzureNetPlugin in Vite because it is a plugin, not an alias.

Each prefix has a root index.ts target and a wildcard mapping. The wildcard default is `./src/app/Contexts/*` (or Presentation/Platform); its types condition also tries `*.ts` and `*/index.ts`. This preserves extensionless imports and directory barrels in TypeScript's bundler resolution. SvelteKit/Vite bundles the application source; this is not a promise that plain Node can execute raw extensionless TypeScript without a loader.

For example: `import { ApplicationProvider } from '#platform/Foundation/DI'`. A scaffolded project's existing `#lib` entry is preserved. See [SvelteKit subpath imports](https://svelte.dev/docs/kit/$lib).

The CLI no longer automatically converts or removes a legacy svelte.config during structure migration. Upgrade legacy SvelteKit configuration separately with its official migration tool. Existing deprecated alias settings are not silently removed while old application code may still use them.

The first datasource is constructed inside an empty generated ApplicationProvider.register. Configure its HTTP options, pass it to repositories and return UseCases factories. User-owned DI is not overwritten. No DatasourceProvider is generated. Until service registration, `void datasource` avoids an unused-variable diagnostic.

For local testing, use a newly named tarball when its contents change. Replacing an archive under the same file: path and version can reuse package-manager cached contents. Verify the installed implementation with the project-local `pnpm exec azure-net`, not an unrelated global executable.

## Reactive state and DI

- `azure-net generate store` selects a presentation workspace and an existing/new scope, then writes a PascalCase `.svelte.ts` class and a `RegisterProvider(..., 'singleton')` accessor. Without workspaces the path is `src/app/Presentation/Scopes/{Scope}/{Name}.svelte.ts`.
- Presenter generation and migration emit `RegisterProvider`.
- Initial structure and migration emit `CreateDiContainer` in `Platform/Foundation/DI/ApplicationProvider.ts`; datasource construction remains inside `register`.
- `defaultPresenterFactory` is no longer supported or generated; migration removes the legacy setting.
- Plugin initialization enables `compilerOptions.experimental.async: true` for `useBoot`/`hydratable` and preserves other literal options. Complex spread configurations need manual editing rather than a guessed rewrite.

### Built-in translation manager

The localization scaffold imports only `@azure-net/kit/i18n`. Await
`TranslationManager().preloadTranslation()` in useServer before resolve;
it writes `state.currLocale` and dictionary snapshots automatically. Call
`TranslationManager().syncFromState(state)` in useBoot and `initializeClient()`
in useClient. Templates include these integration hints. In components use
`t(key)` and `manager.locale`, not `$t` / `$locale`. No separate translations
package, exportState or restoreState is required.

### Presenter and translation API migration

- Presenter factory imports are resolved through local modules and barrels, including aliases.
- Statically declared custom injections (for example notification/modal accessors) become constructor arguments. The factory module retains a plain exported dependency object, not a createPresenterFactory call.
- Async helpers are imported from @azure-net/kit/delivery; factory-specific error types are preserved with type-only specialization. Custom overrides are injected rather than replaced with kit helpers.
- Closures, mutable private variables and detached callbacks are retained behind class accessors. Registration uses RegisterProvider with scoped lifecycle. Consumers and re-exports are updated.
- Opaque spreads, getter-based injection definitions, local per-presenter injection overrides, explicit factory result types and unsupported return shapes require manual review. No application configuration is executed to infer their meaning.
- A single identifiable translation manager is connected to useTranslations before the existing bootstrap chain. Known zero-argument legacy preload/initialization calls become resolved promises so existing helper consumers remain compatible. Custom locale resolvers and ambiguous managers are not rewritten automatically.
- Existing bootstrap dependencies/Container usage, stores and other removed kit APIs are not converted into new application-specific state architecture by this migration. Check the resulting project and migration report before publishing.

Run azure-net migrate --dry-run first. Migration also works on presenters left behind in an already migrated Contexts/Presentation/Platform structure.
