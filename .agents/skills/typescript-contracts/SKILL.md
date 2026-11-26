---
name: typescript-contracts
description: Use when writing or reviewing TypeScript, including data modeling, narrowing, service contracts, schema boundaries, testing, and structured diagnostics.
---

# TypeScript contracts

## Design the types

- **Discriminated unions.** Model alternatives with a required literal `kind`, `type`, or `status`; follow the surrounding convention. A variant should carry the fields valid for it instead of relying on flags and unrelated optional fields.
- **Semantic brands.** When primitives share a representation but must not be interchanged, use distinct brands following the local convention. Validate when constructing a branded value; an unchecked cast does not establish the invariant.
- **Constructive modeling.** Represent invariants in the shape where possible: use `[T, ...T[]]` when a collection must be non-empty, or represent a range with a start and a validated duration instead of relying on two independently supplied endpoints.
- **Simplest total type.** Keep plain types when they cover all legitimate inputs. Strengthen the input when its invariant is real, or return `undefined` explicitly when absence is legitimate; avoid assertions and impossible-case throws as substitutes.
- **Named arguments.** Use object arguments when positional values can be swapped or are hard to understand at the call site. Keep positional arguments where they are clear or a measured hot path warrants them.

## Validate and narrow

- Treat external data as `unknown`, not `any`. Decode once where it enters, then use the decoded type internally. Keep forward-compatible wire formats tolerant of additive fields where the protocol permits; handle invalid or older persisted data explicitly.
- Reuse the repository's schema library before writing field-by-field guards. Derive types from the schema or generated contract that owns the shape. Reuse existing types and projections (`Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, `typeof`) before duplicating declarations.
- Prefer discriminant checks, then `in`, then `typeof` or `instanceof`. Use a user-defined type guard only when needed, and make it verify every fact it claims. Do not use an `as` assertion to bypass a missing proof; prefer `satisfies` to check a value while retaining its inferred literal types.
- Check exhaustive dispatch over closed unions with a `never` check so adding a variant forces its callers to handle it.

## Verify the implementation

- Prefer explicit methods for distinct operations when that avoids a generic dispatcher.
- If dispatch is useful, type each handler against its own input and output. A generic overload over an implementation returning `unknown` or a broad union does not enforce the relationship between a branch and its return value. Check the handlers with an explicit type or `satisfies`, rather than asserting the result type.
- For an input-dependent return, prove both directions: assert the type the caller receives, and show that a broken handler fails typecheck. Use a negative `@ts-expect-error` test included in the project's typecheck, or temporarily break the implementation and verify the compiler rejects it. Run a separate runtime validation test when the result crosses an untrusted boundary.
- Exercise real code with the framework's test primitives and verify cleanup for owned resources. Mock external dependencies that are impractical to run locally. Verify UI changes in a running build when applicable.
- Use structured diagnostics with the context needed to identify a failure. In Wisp's Effect code, use `Effect.log*` with annotations; avoid `console.log` in shipped code.

Adapted from Cursor's [Type System Discipline](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-type-system-discipline/SKILL.md) and [TypeScript Best Practices](https://github.com/cursor/plugins/blob/main/pstack/skills/typescript-best-practices/SKILL.md). See the upstream [TypeScript patterns](https://github.com/cursor/plugins/blob/main/pstack/skills/typescript-best-practices/references/patterns.md) for examples.
