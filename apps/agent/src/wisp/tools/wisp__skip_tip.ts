// @effect-migrated
import { defineTool, effectToolInput } from '@wisp/agent/tool';
import { NoArgs } from '../../contract/tool-inputs.ts';

export default defineTool({
  description:
    'For an automatic suggestion only: finish silently when there is no verified useful tip. Never use for a user question.',
  inputSchema: effectToolInput(NoArgs, { layout: 'zod' }),
  endsTurn: true,
  execute: () => ({ skipped: true }),
});
