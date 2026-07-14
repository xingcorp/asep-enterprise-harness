# Contract Compatibility Policy

The 12 canonical platform contracts live as JSON Schemas under
[`schema/*.schema.json`](./schema). Each schema declares a semantic `version`
(`major.minor.patch`) and a stable `$id`
(`https://asep.dev/schema/<name>/v1`). The JSON Schema is the **single source of
truth**: the TypeScript types in `src/generated.ts` are generated from it, and
the runtime validators in `src/validate.ts` compile it directly. Neither can
drift from the schema without the drift-guard test failing (`src/drift.test.ts`).

## Semantic versioning rules

The compatibility checker (`src/compat.ts`, exercised by `src/compat.test.ts`)
classifies the structural delta between two versions of a schema and asserts the
declared `version` was bumped at least as far as the change requires. CI fails
when a change is under-versioned.

| Change | Bump | Rationale |
| --- | --- | --- |
| Add an **optional** property | MINOR | Existing producers/consumers keep working. |
| Add a new **enum value** | MINOR | Old data still validates; new value is additive. |
| Relax a **required** property to optional | MINOR | Previously valid data stays valid. |
| Remove a property | **MAJOR** | Breaks consumers that read the field. |
| Rename a property | **MAJOR** | Modeled as a removal + addition. |
| Change a property's `type` | **MAJOR** | Breaks producers and consumers. |
| Add a new **required** property | **MAJOR** | Existing producers become invalid. |
| Tighten an **optional** property to required | **MAJOR** | Existing data may be rejected. |
| Remove an **enum value** | **MAJOR** | Previously valid data is rejected. |
| Description / example / annotation only | PATCH / NONE | No structural effect. |

When unsure, the checker escalates to the higher bump level. A breaking change
(MAJOR) is expected to mint a new `$id` version path segment (`/v2`) so that
`/v1` consumers continue to resolve the frozen prior schema.

## Workflow when editing a contract

1. Edit the schema under `schema/<name>.schema.json`.
2. Regenerate the TypeScript projection:
   `pnpm --filter @asep/contracts gen:types`.
3. Bump the schema's `version` per the table above.
4. Update fixtures under `fixtures/{valid,invalid}/` and the template under
   `templates/` if the shape changed.
5. Run `pnpm --filter @asep/contracts exec tsx --test src/*.test.ts`. The
   drift-guard, template-validation, fixture accept/reject, and compatibility
   tests must all pass.

## Automated enforcement

- **Drift guard** — regenerating `generated.ts` in memory must be byte-identical
  to the committed file, so a schema edit without regeneration fails.
- **Template validation** — every `templates/*.yaml` is validated against its
  schema, so templates cannot drift from the contracts.
- **Fixture accept/reject** — every valid fixture must be accepted and every
  invalid fixture must be rejected with a real validation error.
- **Compatibility checker** — mutation fixtures prove that additive changes are
  MINOR and removals/renames/type-changes/tightening are MAJOR, and that an
  under-bumped `version` is rejected.
