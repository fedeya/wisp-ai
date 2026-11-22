import { timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';
import { extractBearerToken, localDev, type AuthFn } from 'eve/channels/auth';

const desktop: AuthFn<Request> = async (request) => {
  const expected = process.env.WOW_BRIDGE_TOKEN;
  const supplied = extractBearerToken(request.headers.get('authorization'));
  if (!expected || !supplied) {
    return null;
  }
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return null;
  }
  return {
    authenticator: 'wisp-desktop',
    principalId: 'local-bridge',
    principalType: 'service',
    attributes: {},
  };
};

// localDev() admits callers only in local development, where evals replace
// game and integration tools with fixtures.
const developer = localDev();
export default eveChannel({
  auth: [
    desktop,
    async (request) => {
      const caller = await developer(request);
      return caller ? { ...caller, allowToolStubs: true } : null;
    },
  ],
});
