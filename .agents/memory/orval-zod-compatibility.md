---
name: Orval and Zod compatibility
description: Compatibility constraint between the current Orval output and the workspace Zod runtime.
---

OpenAPI `integer` schemas currently generate `zod.int()` in the workspace's Orval output, but the pinned Zod 3 runtime does not expose that helper. Use numeric schemas where integer-only runtime validation is not essential, or upgrade the workspace Zod/runtime and regenerate all clients together.

**Why:** Code generation succeeds, but the chained library typecheck fails after generation when the generated Zod API references `zod.int()`.

**How to apply:** After OpenAPI changes, run codegen and the library typecheck before using generated hooks or server schemas.