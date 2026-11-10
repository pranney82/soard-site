/**
 * The Pages Functions router, as Cloudflare runs it, for the split server
 * build (scripts/build-worker.mjs).
 *
 * This is wrangler's own router (templates/pages-template-worker.ts, wrangler
 * 4.86) with two changes and nothing else:
 *
 * 1. Each handler is loaded the first time a request needs it. A route holds
 *    loaders (() => import(...)) instead of the functions themselves, so a page
 *    runs only its own middleware, never the whole server. Middleware chains,
 *    route order, next(), context.data, passThroughOnException and the fall
 *    back to the static files work exactly as before: a loaded export is
 *    flattened the same way ([export].flat(), which is what wrangler's
 *    route.middlewares.flat() does to each export).
 * 2. Each route's two matchers are built once, not on every request.
 *
 * tests/build-worker.test.mjs runs this and wrangler's original side by side.
 */

import { match } from 'path-to-regexp';

// Note: explicitly does not include the * character, as pages requires this
const escapeRegex = /[.+?^${}()|[\]\\]/g;

const matchers = new Map();
/** match() for a route or mount path, built once per path and option */
function matcher(path, end) {
  const key = `${end ? 1 : 0}${path}`;
  let m = matchers.get(key);
  if (!m) {
    m = match(path.replace(escapeRegex, '\\$&'), { end });
    matchers.set(key, m);
  }
  return m;
}

/** The functions a loader stands for, in order (an export can be one function or an array of them) */
async function handlersOf(loaders) {
  const out = [];
  for (const load of loaders) out.push(...[await load()].flat());
  return out;
}

async function* executeRequest(routes, request) {
  const requestPath = new URL(request.url).pathname;

  // First, iterate through the routes (backwards) and execute "middlewares" on partial route matches
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) continue;
    const matchResult = matcher(route.routePath, false)(requestPath);
    const mountMatchResult = matcher(route.mountPath, false)(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of await handlersOf(route.middlewares)) {
        yield { handler, params: matchResult.params, path: mountMatchResult.path };
      }
    }
  }

  // Then look for the first exact route match and execute its "modules"
  for (const route of routes) {
    if (route.method && route.method !== request.method) continue;
    const matchResult = matcher(route.routePath, true)(requestPath);
    const mountMatchResult = matcher(route.mountPath, false)(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of await handlersOf(route.modules)) {
        yield { handler, params: matchResult.params, path: matchResult.path };
      }
      break;
    }
  }
}

// This makes a Response mutable
const cloneResponse = (response) =>
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response([101, 204, 205, 304].includes(response.status) ? null : response.body, response);

/** The worker: `routes` as scripts/build-worker.mjs writes them, `fallbackService` the binding that serves the static files */
export function createWorker(routes, fallbackService = 'ASSETS') {
  return {
    async fetch(originalRequest, env, workerContext) {
      let request = originalRequest;
      const handlerIterator = executeRequest(routes, request);
      let data = {}; // arbitrary data the user can set between functions
      let isFailOpen = false;

      const next = async (input, init) => {
        if (input !== undefined) {
          let url = input;
          if (typeof input === 'string') url = new URL(input, request.url).toString();
          request = new Request(url, init);
        }

        const result = await handlerIterator.next();
        if (result.done === false) {
          const { handler, params, path } = result.value;
          const context = {
            request: new Request(request.clone()),
            functionPath: path,
            next,
            params,
            get data() {
              return data;
            },
            set data(value) {
              if (typeof value !== 'object' || value === null) throw new Error('context.data must be an object');
              // user has overriden context.data, so we need to merge it with the existing data
              data = value;
            },
            env,
            waitUntil: workerContext.waitUntil.bind(workerContext),
            passThroughOnException: () => {
              isFailOpen = true;
            },
          };

          const response = await handler(context);
          if (!(response instanceof Response)) throw new Error('Your Pages function should return a Response');
          return cloneResponse(response);
        } else if (fallbackService) {
          // There are no more handlers so finish with the fallback service (`env.ASSETS.fetch` in Pages' case)
          return cloneResponse(await env[fallbackService].fetch(request));
        } else {
          // There was not fallback service so actually make the request to the origin.
          return cloneResponse(await fetch(request));
        }
      };

      try {
        return await next();
      } catch (error) {
        if (isFailOpen) return cloneResponse(await env[fallbackService].fetch(request));
        throw error;
      }
    },
  };
}
