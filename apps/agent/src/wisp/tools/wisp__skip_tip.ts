import { defineTool } from '@wisp/agent/tool';
import { z } from 'zod';

export default defineTool({
  description:
    'For an automatic suggestion only: finish silently when there is no verified useful tip. Never use for a user question.',
  inputSchema: z.object({}),
  endsTurn: true,
  execute: () => ({ skipped: true }),
});
