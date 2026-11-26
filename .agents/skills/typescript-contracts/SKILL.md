---
name: typescript-contracts
description: Use when designing or reviewing TypeScript contracts, especially discriminated unions, service handlers, overloads, schema boundaries, and APIs whose return type depends on input.
---

# TypeScript contracts

Make the compiler verify the implementation as well as what callers see.

- Model distinct variants with a literal discriminant and check exhaustive dispatch. Prefer explicit methods for distinct operations when that avoids a generic dispatcher.
- If dispatch is useful, type each handler against its own input and output. A generic overload over an implementation returning `unknown` or a broad union does not enforce the relationship between a branch and its return value. Check the handlers with an explicit type or `satisfies`, rather than asserting the result type.
- Decode external data at the boundary and derive types from the authoritative schema. Use `unknown` for input you have not decoded; keep it out of a producer's return type when the producer owns a known shape. Use distinct types for primitives with different meanings when confusing them would break an invariant.
- For an input-dependent return, prove both directions: assert the type the caller receives, and show that a broken handler fails typecheck. Use a negative `@ts-expect-error` test included in the project's typecheck, or temporarily break the implementation and verify the compiler rejects it. Run a separate runtime validation test when the result crosses an untrusted boundary.

Inspired by Cursor's [Type System Discipline](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-type-system-discipline/SKILL.md) and [TypeScript Best Practices](https://github.com/cursor/plugins/blob/main/pstack/skills/typescript-best-practices/SKILL.md).
