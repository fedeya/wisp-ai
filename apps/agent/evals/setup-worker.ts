import { afterEach, beforeEach, inject } from 'vitest';
import { setAgentHost } from '../src/host/agent-host.ts';

beforeEach(() => setAgentHost(inject('evalBridge')));
afterEach(() => setAgentHost(undefined));
