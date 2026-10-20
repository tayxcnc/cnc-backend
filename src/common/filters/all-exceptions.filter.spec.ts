import {
  type ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { runWithRequestContext } from '../request-context';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * The filter's whole reason for existing is the duck-type leak, so that is the
 * first test. The rest pin that it did not change any deliberate refusal on
 * its way past.
 */

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

/** The two methods the filter calls, chained as Express chains them. */
interface FakeResponse {
  status(code: number): FakeResponse;
  json(body: Record<string, unknown>): FakeResponse;
}

function hostFor(
  captured: Captured,
  getRequest: () => unknown = () => ({}),
): ArgumentsHost {
  const response: FakeResponse = {
    status(code) {
      captured.status = code;
      return response;
    },
    json(body) {
      captured.body = body;
      return response;
    },
  };

  return {
    switchToHttp: () => ({ getResponse: () => response, getRequest }),
  } as unknown as ArgumentsHost;
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let captured: Captured;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    captured = {};
    // The filter logs the exception; the log itself is not under test and its
    // output would bury the suite's own.
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('turns an object that merely looks like an HTTP error into a generic 500', () => {
    // The leak. `http-errors` instances and several database drivers throw
    // objects shaped exactly like this, and Nest's built-in filter echoes the
    // message to the caller with the status.
    const looksHttp = {
      statusCode: 409,
      message:
        'duplicate key value violates unique constraint "Customer_email_key"',
    };

    filter.catch(looksHttp, hostFor(captured));

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('turns an ordinary Error into a generic 500 carrying nothing of it', () => {
    filter.catch(
      new Error('connect ECONNREFUSED 10.1.2.3:5432'),
      hostFor(captured),
    );

    expect(captured.status).toBe(500);
    expect(JSON.stringify(captured.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(captured.body)).not.toContain('10.1.2.3');
  });

  it('passes a deliberate 4xx through with its status and its wording', () => {
    // The sign-in message is enumeration-safe by design and the e2e suites
    // assert it verbatim. A filter that rewrote it would be a security change
    // hidden in an error handler.
    filter.catch(
      new UnauthorizedException('Email or password is incorrect.'),
      hostFor(captured),
    );

    expect(captured.status).toBe(401);
    expect(captured.body).toMatchObject({
      statusCode: 401,
      message: 'Email or password is incorrect.',
    });
  });

  it('keeps a domain message byte for byte, because the screens show it', () => {
    filter.catch(
      new ConflictException('This record changed. Refresh and try again.'),
      hostFor(captured),
    );

    expect(captured.status).toBe(409);
    expect(captured.body?.message).toBe(
      'This record changed. Refresh and try again.',
    );
  });

  it("keeps the ValidationPipe's array of messages as an array", () => {
    filter.catch(
      new BadRequestException([
        'phone must be a Nigerian number',
        'email must be an email',
      ]),
      hostFor(captured),
    );

    expect(captured.body?.message).toEqual([
      'phone must be a Nigerian number',
      'email must be an email',
    ]);
  });

  it('adds the request id to a 4xx so a refused caller can quote it', () => {
    runWithRequestContext({ requestId: 'req-4xx' }, () => {
      filter.catch(new BadRequestException('Nope.'), hostFor(captured));
    });

    expect(captured.body?.requestId).toBe('req-4xx');
  });

  it('adds the request id to the generic 500', () => {
    runWithRequestContext({ requestId: 'req-500' }, () => {
      filter.catch(new Error('boom'), hostFor(captured));
    });

    expect(captured.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      requestId: 'req-500',
    });
  });

  it('omits the id rather than inventing one outside a request', () => {
    filter.catch(new Error('boom'), hostFor(captured));

    expect(captured.body).not.toHaveProperty('requestId');
  });

  it('logs a 5xx HttpException but not a 4xx', () => {
    const logged = jest.spyOn(filter['logger'], 'error');

    filter.catch(new BadRequestException('client fault'), hostFor(captured));
    expect(logged).not.toHaveBeenCalled();

    filter.catch(
      new HttpException('server fault', HttpStatus.BAD_GATEWAY),
      hostFor(captured),
    );
    expect(logged).toHaveBeenCalledTimes(1);
  });

  /**
   * Browsers send every `tayxcnc.com` cookie to this API, another service's
   * refresh token included (plan A16). The filter must never look at the
   * request, so no header can reach a body or a log line through it.
   */
  it('never reads the request, so a cookie cannot reach a body or a log', () => {
    const logged = jest.spyOn(filter['logger'], 'error');
    const getRequest = jest.fn(() => ({
      headers: { cookie: 'tay_refresh_token=secret-cookie-value' },
    }));

    filter.catch(new Error('boom'), hostFor(captured, getRequest));
    filter.catch(
      new BadRequestException('Nope.'),
      hostFor(captured, getRequest),
    );

    expect(getRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(captured.body)).not.toContain('secret-cookie-value');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(
      'secret-cookie-value',
    );
  });

  describe('platform-level client faults', () => {
    /** The shape body-parser throws for an oversized body. */
    const oversized = () =>
      Object.assign(new Error('request entity too large'), {
        status: 413,
        statusCode: 413,
        expose: true,
        type: 'entity.too.large',
      });

    it('keeps the status of an oversized body rather than calling it a 500', () => {
      // A 500 here would make a caller's own mistake look like this service's
      // fault and let anyone raise the 5xx rate with a large POST.
      filter.catch(oversized(), hostFor(captured));

      expect(captured.status).toBe(413);
    });

    it('answers with the standard reason phrase, not the thrown message', () => {
      filter.catch(oversized(), hostFor(captured));

      expect(captured.body).toMatchObject({
        statusCode: 413,
        message: 'Payload Too Large',
      });
      expect(JSON.stringify(captured.body)).not.toContain('entity');
    });

    it('still refuses the duck-typed database error, which is the leak', () => {
      // The difference that matters. A Postgres driver error carries a
      // statusCode and a message but no `expose`, so it cannot pass. If this
      // ever goes green at 409, the leak is back.
      filter.catch(
        {
          statusCode: 409,
          status: 409,
          message: 'duplicate key value violates unique constraint "x_key"',
        },
        hostFor(captured),
      );

      expect(captured.status).toBe(500);
      expect(JSON.stringify(captured.body)).not.toContain('duplicate key');
    });

    it('refuses anything that claims to be exposable at a 5xx', () => {
      // `http-errors` sets expose false for 5xx; an object setting it true is
      // not one, and a server fault is never the caller's to read.
      filter.catch(
        Object.assign(new Error('upstream exploded'), {
          status: 502,
          expose: true,
        }),
        hostFor(captured),
      );

      expect(captured.status).toBe(500);
      expect(JSON.stringify(captured.body)).not.toContain('upstream');
    });

    it('carries the request id like every other refusal', () => {
      runWithRequestContext({ requestId: 'req-413' }, () => {
        filter.catch(oversized(), hostFor(captured));
      });

      expect(captured.body?.requestId).toBe('req-413');
    });

    it('does not log it as an error, because it is not one', () => {
      const logged = jest.spyOn(filter['logger'], 'error');

      filter.catch(oversized(), hostFor(captured));

      expect(logged).not.toHaveBeenCalled();
    });
  });

  it('logs and returns rather than throwing when there is no HTTP response', () => {
    const noHttp = {
      switchToHttp: () => ({ getResponse: () => ({}) }),
    } as unknown as ArgumentsHost;

    expect(() =>
      filter.catch(new Error('outside a request'), noHttp),
    ).not.toThrow();
  });
});
