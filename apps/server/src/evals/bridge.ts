// @effect-migrated allow=nodeIoImports,effectPromises: the model proxy is not on Effect yet and answers on node:http's request and response
// Model bridge for agent evals (apps/agent/evals). It uses Wisp's own ChatGPT
// sign-in and model proxy with a separate data folder, so eval sessions never
// share or refresh the installed app's tokens. Game tools are eval stubs.
// eval-bridge.ts runs it.
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as NodeHttpServerRequest from '@effect/platform-node/NodeHttpServerRequest';
import { Config, Console, Effect, Layer, Option, Path, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';
import { Hex } from 'effect/encoding';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import * as ChatGPTAuth from '#/auth';
import * as HttpClient from '#/platform/http-client';
import * as SecretVault from '#/platform/secret-vault';
import { createModelProxy } from '../models/model-proxy.ts';
import { promiseChatGPTAuth } from '../runtime.ts';

/** The eval bridge cannot sign in or serve; the message says why. */
export class EvalBridgeError extends Schema.TaggedError<EvalBridgeError>()('EvalBridgeError', {
  message: Schema.String,
}) {}

/** A variable that is set and not empty. */
const nonEmpty = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value) => value !== '')));

export interface EvalBridgeOptions {
  /** Where the eval sign-in keeps its files and protected credentials. */
  readonly dataDir: string;
  /** The desktop executable, which stores the credentials as the vault helper. */
  readonly desktop: string;
}

/** Reads `WISP_EVAL_DATA_DIR` (`~/.wisp-evals` by default) and `WISP_DESKTOP_EXE`. */
export const options = Effect.gen(function* () {
  const path = yield* Path.Path;
  const dataDir = yield* nonEmpty('WISP_EVAL_DATA_DIR');
  const desktop = yield* nonEmpty('WISP_DESKTOP_EXE');
  const localAppData = yield* Config.String('LOCALAPPDATA').pipe(Config.withDefault(''));
  return {
    dataDir: path.resolve(Option.getOrElse(dataDir, () => path.join(os.homedir(), '.wisp-evals'))),
    desktop: Option.getOrElse(desktop, () =>
      path.join(localAppData, 'Programs', 'Wisp AI', 'wisp.exe'),
    ),
  } satisfies EvalBridgeOptions;
});

/**
 * ChatGPTAuth for evals: it keeps the eval host identifier in the eval data
 * folder, and the vault helper keeps its secrets under that folder too, apart
 * from the app's.
 */
export const authLayer = ({ dataDir, desktop }: EvalBridgeOptions) =>
  ChatGPTAuth.layerAt(dataDir).pipe(
    Layer.provide([
      SecretVault.layerHelper({ command: [desktop], env: { WISP_DATA_DIR: dataDir } }),
      HttpClient.layer,
      NodeCrypto.layerDigest,
      NodeCrypto.layerSecureRandom,
      NodeCrypto.layerSignature,
    ]),
  );

/** Signs the evals in to ChatGPT in the browser, unless they already are. */
export const signIn = Effect.fn('EvalBridge.signIn')(function* () {
  const auth = yield* ChatGPTAuth.ChatGPTAuth;
  const state = yield* auth.state;
  if (state.status === 'connected') {
    yield* Console.log('Evals are already signed in to ChatGPT as ' + state.account + '.');
    return;
  }
  const { authorizationUrl } = yield* auth.beginSignIn({ newAccount: true });
  yield* Console.log(
    'Open this link to sign in to ChatGPT for Wisp evals:\n\n' + authorizationUrl + '\n',
  );
  const settled = yield* auth.state.pipe(
    Effect.delay('1 second'),
    Effect.repeat({ until: ({ status }) => status !== 'authorizing' }),
  );
  if (settled.status !== 'connected') {
    return yield* new EvalBridgeError({
      message: settled.message || 'Sign-in did not finish (' + settled.status + ').',
    });
  }
  // Let the vault finish saving the new session before the process exits.
  yield* Effect.sleep('2 seconds');
  yield* Console.log('Signed in as ' + settled.account + '. You can run the evals now.');
});

/** Where the eval model server listens, as the agent's evals read it from stdout. */
export interface EvalServer {
  readonly url: string;
  readonly token: string;
  readonly model: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the model proxy answers when it fails before sending its own response. */
const modelError = (message: string) =>
  HttpServerResponse.text(JSON.stringify({ error: { message } }), {
    status: 503,
    contentType: 'application/json',
    headers: { 'x-wisp-model-error': 'true' },
  });

/**
 * Serves the model on a random loopback port while the current scope is open:
 * `GET /session-model` and `POST /model/responses`, for requests with the
 * returned bearer token. Every other path answers 503, so a case stubs the
 * tool that reached for it.
 */
export const serve = Effect.fn('EvalBridge.serve')(function* () {
  const auth = yield* ChatGPTAuth.ChatGPTAuth;
  const random = yield* SecureRandom.SecureRandom;
  const proxyModel = yield* createModelProxy(promiseChatGPTAuth(auth, yield* Effect.context()));
  if ((yield* auth.state).status !== 'connected') {
    return yield* new EvalBridgeError({
      message:
        'Evals are not signed in to ChatGPT. Run: node apps/server/src/evals/eval-bridge.ts sign-in',
    });
  }
  const models = yield* auth.models;
  const model = Option.getOrElse(yield* nonEmpty('WISP_EVAL_MODEL'), () => models[0]?.slug);
  if (!model || !models.some((entry) => entry.slug === model)) {
    return yield* new EvalBridgeError({
      message:
        'Choose an available eval model with WISP_EVAL_MODEL: ' +
        models.map((entry) => entry.slug).join(', '),
    });
  }
  const effort = Option.getOrElse(yield* nonEmpty('WISP_EVAL_EFFORT'), () => 'medium');
  const token = Hex.encode(yield* random.randomBytes(24));

  const proxy = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const req = NodeHttpServerRequest.toIncomingMessage(request);
    const res = NodeHttpServerRequest.toServerResponse(request);
    if (!(req instanceof IncomingMessage) || !(res instanceof ServerResponse)) {
      return yield* Effect.die('The eval bridge serves HTTP/1.1 only');
    }
    return yield* Effect.tryPromise({
      try: () => proxyModel(req, res),
      catch: (cause) =>
        new EvalBridgeError({
          message: cause instanceof Error ? cause.message : 'Eval bridge failed',
        }),
    }).pipe(
      // The proxy has answered on the Node response itself.
      Effect.as(HttpServerResponse.empty()),
      Effect.catchTag('EvalBridgeError', (error) =>
        res.headersSent
          ? Effect.sync(() => {
              res.destroy();
              return HttpServerResponse.empty();
            })
          : Effect.succeed(modelError(error.message)),
      ),
    );
  });

  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.authorization !== 'Bearer ' + token) {
      return HttpServerResponse.text('Forbidden', { status: 403 });
    }
    const url = URL.parse(request.url, 'http://127.0.0.1');
    if (!url) {
      return modelError('Invalid URL');
    }
    if (request.method === 'GET' && url.pathname === '/session-model') {
      return HttpServerResponse.text(JSON.stringify({ model, effort, webSearchAvailable: true }), {
        contentType: 'application/json',
      });
    }
    if (request.method === 'POST' && url.pathname === '/model/responses') {
      return yield* proxy(request);
    }
    return HttpServerResponse.text(
      'Not available in evals: stub this tool (' + url.pathname + ').',
      { status: 503, contentType: 'text/plain' },
    );
  });

  const server = yield* NodeHttpServer.make(() => createServer(), { host: '127.0.0.1', port: 0 });
  yield* server.serve(app);
  if (server.address._tag === 'UnixPathAddress') {
    return yield* Effect.die('The eval bridge is not listening on a port');
  }
  return {
    url: 'http://127.0.0.1:' + server.address.port,
    token,
    model,
  } satisfies EvalServer;
});

/** What the bridge prints when it stops on a failure. */
export const failureMessage = (error: unknown) =>
  // ChatGPT request failures keep what the request failed with.
  error instanceof ChatGPTAuth.ChatGPTRequestError ? messageOf(error.cause) : messageOf(error);
