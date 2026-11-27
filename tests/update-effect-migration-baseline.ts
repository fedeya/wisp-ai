// Records today's Effect migration counts as the new baseline:
// `pnpm --filter @wisp/tests effect:baseline`.
import { writeBaseline } from './effect-migration.ts';

writeBaseline();
