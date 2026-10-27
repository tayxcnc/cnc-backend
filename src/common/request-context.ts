import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What every log line and every error body needs to know about the request it
 * belongs to, carried without threading a parameter through forty services.
 *
 * ## Why AsyncLocalStorage and not injection
 *
 * A request-scoped provider in Nest makes every service that reads it
 * request-scoped too, and that propagates up the whole injection graph — a
 * singleton service that injects a request-scoped one becomes request-scoped
 * itself, which means it is constructed per request. That is a real cost on a
 * container that scales to zero and pays a cold start for every first visitor.
 *
 * `AsyncLocalStorage` costs nothing at injection time. The middleware opens a
 * store around the rest of the request, and anything running inside that
 * asynchronous context can read it — a service, a logger, the exception
 * filter — without declaring a dependency on it at all.
 *
 * ## What is deliberately not in here
 *
 * No customer id, no staff id, no token, no cookie, no body. This store is
 * read by the logger, and a log line must never carry a secret, a token or an
 * email body: logs are read by more people, and kept longer, than the data
 * they describe. Keeping the store to an opaque identifier means there is
 * nothing in it that would be a problem in a log line.
 */
export interface RequestContext {
  /**
   * The id that appears on the response header, in every log line for this
   * request, and in the error body if it fails. Either the caller's own
   * `X-Request-Id` or one generated for them.
   */
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `callback` with `context` readable by everything inside it. */
export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

/**
 * The current request's id, or `undefined` outside a request.
 *
 * `undefined` is a real answer, not a failure: application bootstrap, a seed
 * script, and anything a test calls directly all run outside any request.
 * Callers render it as absent rather than inventing one, because an invented
 * id is worse than none — it would look findable in the logs and never be
 * found.
 */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
