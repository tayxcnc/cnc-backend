import type {
  PushOptions,
  PushOutcome,
  PushPayload,
  PushSender,
  PushTarget,
} from '../src/push/push-sender';

/**
 * Stands in for the push sender in every e2e suite (C10), copied from TAY's
 * `FakePushSender` and adapted.
 *
 * The real one signs with the VAPID pair and posts to a browser vendor's
 * push service. A suite must never do that: with keys in a local `.env` it
 * would reach a real device. This one records each send and answers with
 * an outcome chosen per endpoint prefix (SENT unless a test says
 * otherwise), so a suite can make a device GONE, KEY_MISMATCH, REJECTED or
 * RETRY without a network, and can slow every send down (`delay`) to prove
 * a lease outlasts it.
 *
 * `isConfigured` is true, as on staging, so pushes are written and sent.
 * Nothing here reads a key. Read it with `pushSender(app)`.
 */
export class RecordingPushSender implements PushSender {
  readonly isConfigured = true;

  readonly sent: {
    endpoint: string;
    payload: PushPayload;
    options: PushOptions;
  }[] = [];

  private readonly outcomes: { prefix: string; outcome: PushOutcome }[] = [];

  private delayMs = 0;

  /**
   * Make every later send to an endpoint starting with `endpointPrefix`
   * answer `outcome`. The latest matching rule wins.
   */
  answer(endpointPrefix: string, outcome: PushOutcome): void {
    this.outcomes.unshift({ prefix: endpointPrefix, outcome });
  }

  /** Make every later send take `ms` milliseconds before it answers. */
  delay(ms: number): void {
    this.delayMs = ms;
  }

  async send(
    target: PushTarget,
    payload: PushPayload,
    options: PushOptions,
  ): Promise<PushOutcome> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    this.sent.push({ endpoint: target.endpoint, payload, options });

    return (
      this.outcomes.find(({ prefix }) => target.endpoint.startsWith(prefix))
        ?.outcome ?? 'SENT'
    );
  }

  /** Sends to endpoints that start with `prefix`: one suite's own. */
  sentTo(prefix: string) {
    return this.sent.filter(({ endpoint }) => endpoint.startsWith(prefix));
  }
}
