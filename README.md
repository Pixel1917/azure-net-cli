# @azure-net/cli

Architecture scaffolding and checks for SvelteKit applications using `@azure-net/kit`.
Install the CLI as a dev dependency. Node >=22.15 is required. Generation does not install Husky, commitlint, commitizen or other tools.

## Architecture

```text
src/
  program.ts
  app/
    Contexts/
      SharedKernel/{Contracts,Domain}
      Identity/
        Composition.ts
        Account/
          Domain/{Resources,DTO,Ports,Enums}
          Application/UseCases/AccountUseCases.ts
          Infrastructure/Repositories/AccountRepository.ts
    Presentation/
      Public/
        Scopes/Identity/{AccountPresenter.ts,index.ts}
        Shell/
        Ui/
          Actions/
          Style/
          Components/{Core,Page,Scopes,Composite}
      Shared/{Scopes,Shell,Ui}
  platform/
    Bootstrap/Bootstrap.ts
    Foundation/{Cookie,Datasource,Response,Schema,Provider}
```

Fresh structure creates only SharedKernel in Contexts. Aggregates and scopes are created on demand. No empty aggregate, root barrel or ApplicationProvider is generated. Domain barrels expose contracts; presentation scope barrels register class presenters/stores. Components get their own local barrel. Platform is a **sibling** of app, not a child.

```ts
export default {
	appBoundaries: ['Public', 'Admin'],
	runChecksBeforePush: true,
	packageManager: 'pnpm',
	defaultSchemaFactory: 'Schema'
};
```

`presentationWorkspaces` is accepted as a fallback for existing configuration. `appBoundaries` takes precedence. Shared is always included. Existing directories are discovered from disk; configuration supplies initial/additional boundaries. Contexts are not listed in configuration.

Imports use package.json subpath imports: `#contexts/*`, `#presentation/*`, `#platform/*`. Custom mappings are not silently overwritten. Existing mappings to the previous architecture must be migrated first.

## Installation and maintenance

- `azure-net install fresh`: creates structure, configures AzureNetPlugin, creates Bootstrap.ts and program.ts; offers optional Foundation artifacts, translations, error handler, Prettier configuration and Git hooks. No middleware is created by default.
- `azure-net folders-update`: adds missing directories, including boundaries newly added to config. Preserves existing files and boundaries.
- `azure-net prettier-config`: replaces the recommended Prettier configuration without installing packages.
- `azure-net git-hooks add`: adds `azure-net check project` to the pre-commit workflow, preserving unrelated hook code. Disables the redundant pre-push check in configuration.
- `azure-net git-hooks remove`: removes the CLI-owned hook block without deleting unrelated hooks.
- `azure-net commit`: interactive staged commit, with optional body and breaking-change information.
- `azure-net push [--no-check]`: optional checks, git add, interactive commit, git push. Checks default to enabled unless disabled in configuration.

The old `add`, `init`, and `create` commands are removed. Use `prettier-config`, `folders-update`, `install fresh`, `foundation`, and `bootstrap` instead.

## Foundation

```sh
azure-net foundation schema
azure-net foundation schema-rule
azure-net foundation response
azure-net foundation datasource
azure-net foundation cookie-instance
```

Datasource and response templates expose interfaces as well as classes. Repositories depend on the datasource interface. Datasource creation offers an HttpProvider in Foundation/Provider; configure its empty prefixUrl before using it. The provider owns datasource construction, not repositories or use cases. Schema generation records defaultSchemaFactory in config.

## Bootstrap

```sh
azure-net bootstrap translations
azure-net bootstrap middleware
azure-net bootstrap error-handler
```

Translations use TranslationManager and `.useTranslations(manager)`. Middleware generation produces a client and server class with `execute` returning `next()`, under Bootstrap/Pipelines/Middlewares/Name. Delete the unused variant. For an existing customized Bootstrap.ts, commands print wiring instructions rather than rewriting arbitrary application logic. Fresh installation can compose Bootstrap.ts automatically.

## Generators

```sh
azure-net generate aggregate
azure-net generate aggregate-preset
azure-net generate domain
azure-net generate repository
azure-net generate repository-method
azure-net generate use-cases
azure-net generate presenter
azure-net generate store
azure-net generate schema-from-type
azure-net generate types-json
azure-net generate routes
```

The aggregate is selected **inside a context**. Resources describe responses; DTO contains commands and queries. Repository interfaces belong to Domain/Ports. Use cases expose their own interfaces. Presenters consume use-case interfaces and are registered through RegisterProvider in their scope index.ts.

Composition.ts uses CompositionRoot at context level. Automatic composition wiring is optional; custom composition logic must not be overwritten merely to add another aggregate.

Routes are generated into `src/platform/Bootstrap/Routes/index.ts`. Repeated generation replaces the generated route list. Grouping produces separate arrays, not a runtime groups object.

### Components

```sh
azure-net generate component core
azure-net generate component page
azure-net generate component scopes
azure-net generate component composition
```

`composition` targets Components/Composite. Without a category, the CLI asks. Select the boundary, then enter a name such as `Card` or a nested relative path such as `Catalog/ProductCard`. A plain name goes directly under the chosen category (or chosen UI scope). For Scopes you can select an existing scope or create one. Absolute paths and `..` are rejected. Existing components are never overwritten.

## Checks

`azure-net check project` runs the optional read-only `format:check` script, architectural checks, lint and type checking. It never runs the potentially mutating `format` script. `azure-net check internal` runs only the CLI architectural checks. Individual commands include domain, imports, folders-structure, layer-imports, layer-boundaries, hooks, provider-graph, provider-names and presenter-names.

- Contexts cannot import other contexts. Aggregates in one context can cooperate. SharedKernel is importable from contexts, never the reverse.
- Presentation boundaries can import contexts and Shared, not each other. Shared cannot depend on a concrete boundary.
- App directory names use PascalCase letters/digits. Framework filenames outside app retain their framework conventions.
- Consts, utils and common directories are forbidden (case-insensitive). Shared is reserved for Presentation/Shared.
- Context interfaces use I prefix. Resources, enums, repositories, use cases and presenters have their corresponding suffixes. Application/Services and Infrastructure services remain supported.
- Repository/use-case dependencies are typed by interfaces; presenter use-case dependencies are interfaces too. Inferred cookie/storage instances and presenter stores are not indiscriminately rejected.
- Contexts do not contain top-level functions. Class methods and nested DI factories are allowed.
- Imports are ordered runtime, types, then styles/other side-effect imports.

These are static architectural checks, not a security sandbox or a substitute for runtime tests.

## Migration

```sh
azure-net migrate --dry-run
azure-net migrate
```

Commit or back up the project first. Review the plan before applying. Migration preserves uncertain files in app/.backup and reports manual work; it cannot infer arbitrary business semantics. Review the resulting Composition roots, constructors, presenters and Bootstrap, then run project checks. Migration never warrants that an arbitrary legacy application is production-ready without manual verification.

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test
```

TypeScript is the source of truth. Build regenerates adjacent JavaScript used by the published CLI and dist declarations. Never hand-edit generated JavaScript.

## Fast generation

`feature` generates a read operation by default. `feature-preset` generates collection/resource/create/update/destroy. Both use the same templates as the detailed aggregate flow and can run without prompts when all choices are supplied:

```sh
azure-net generate feature-preset \
  --context Commerce --aggregate Order --name Order \
  --route /orders --datasource ApiDatasource \
  --boundary Public --scope Shopping --auto-compose

azure-net generate feature \
  --context SiteMeta --aggregate SiteSettings \
  --route /settings --datasource ApiDatasource \
  --auto-compose --no-presenter
```

For custom methods and typed fields, use a JSON spec rather than answering per-field questions:

```json
{
	"context": "Commerce",
	"aggregate": "Order",
	"datasource": "ApiDatasource",
	"boundary": "Public",
	"scope": "Shopping",
	"composition": true,
	"types": [
		{ "name": "IOrderResource", "layer": "Resources", "fields": { "id": "string", "total": "number" } },
		{ "name": "ICreateOrderCommand", "layer": "DTO", "fields": { "productId": "string", "quantity": "number" } }
	],
	"methods": [
		{ "name": "resource", "httpMethod": "get", "route": "/orders", "pathParam": "string", "response": "IOrderResource" },
		{ "name": "create", "httpMethod": "post", "route": "/orders", "body": "ICreateOrderCommand", "response": "IOrderResource" }
	]
}
```

```sh
azure-net generate feature --spec ./order.feature.json
```

Explicit CLI flags override the spec; unspecified flags do not. `--no-composition` prints manual wiring, `--no-presenter` omits presentation generation, and `--schemas` requests schemas. Without an explicit composition decision, the CLI asks before modifying Composition.ts. Nonliteral/custom DI code is preserved and requires manual wiring. No automatic overwrite of existing aggregate implementations.
