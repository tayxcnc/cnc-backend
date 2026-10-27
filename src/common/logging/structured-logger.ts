import {
  ConsoleLogger,
  type LoggerService,
  type LogLevel,
} from '@nestjs/common';
import { currentRequestId } from '../request-context';

/**
 * The severity names Cloud Logging understands, mapped from Nest's levels.
 *
 * Cloud Logging reads a top-level `severity` string and colours and filters on
 * it. Anything it does not recognise is treated as DEFAULT, which is how a log
 * full of errors ends up looking like a log full of nothing.
 */
const SEVERITY: Record<LogLevel, string> = {
  fatal: 'CRITICAL',
  error: 'ERROR',
  warn: 'WARNING',
  log: 'INFO',
  debug: 'DEBUG',
  verbose: 'DEBUG',
};

/**
 * One JSON object per line, in the shape Cloud Logging parses without
 * configuration.
 *
 * ## Why this shape exactly
 *
 * Cloud Run writes a container's stdout to Cloud Logging. If a line is valid
 * JSON, Logging lifts the recognised fields — `severity`, `message` — to the
 * entry itself and puts everything else under `jsonPayload`, where it is
 * searchable. If a line is not JSON it becomes an opaque `textPayload` and
 * `severity` is always DEFAULT.
 *
 * Cloud **Error Reporting** then needs nothing further: it groups any entry
 * whose severity is ERROR or above and whose payload carries a stack trace. So
 * the `stack` field below is not decoration — it is the whole of the Error
 * Reporting setup, which otherwise requires no configuration.
 *
 * ## Why the format is keyed on NODE_ENV and not CNC_ENV
 *
 * `CNC_ENV` names which deployment this is, and the boot-time rules read it
 * and nothing else. This is a different question: is this process running as
 * a built container, whose stdout a log aggregator is reading, or on
 * somebody's machine where a human is reading it. `NODE_ENV` is exactly that
 * question and is what the Dockerfile sets. Staging and production both want
 * JSON; a developer and the test suites both want the readable form.
 *
 * ## The request id
 *
 * Read from the AsyncLocalStorage store rather than passed in, so that every
 * `this.logger.warn(...)` already written anywhere in the codebase gains a
 * request id without being touched. Outside a request it is absent rather
 * than invented.
 *
 * ## What it never writes
 *
 * Only what a caller hands it. Nothing here reads the request, so a header —
 * a cookie above all, including another service's cookie a browser sends to
 * this API — cannot reach a log line by way of this class.
 */
export class StructuredLogger implements LoggerService {
  /**
   * Used only when the readable format is selected. Composition rather than
   * inheritance: this class implements `LoggerService` and delegates, so the
   * two formats cannot drift into sharing half of Nest's console behaviour.
   */
  private readonly readable = new ConsoleLogger();

  constructor(private readonly asJson: boolean) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('log', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('verbose', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  /**
   * Nest calls a logger with `(message, context)` for most levels and
   * `(message, stack, context)` for `error`, and both arrive here as `rest`.
   * The shapes are told apart by position and type rather than by trusting the
   * level, because `error` is also called with two arguments from plenty of
   * places.
   */
  private write(level: LogLevel, message: unknown, rest: unknown[]): void {
    if (!this.asJson) {
      (this.readable[level] as (...args: unknown[]) => void)(message, ...rest);
      return;
    }

    const strings = rest.filter(
      (item): item is string => typeof item === 'string',
    );
    const context =
      strings.length > 0 ? strings[strings.length - 1] : undefined;
    const stack =
      level === 'error' && strings.length > 1 ? strings[0] : stackOf(message);

    const entry: Record<string, unknown> = {
      severity: SEVERITY[level],
      message: textOf(message),
      time: new Date().toISOString(),
    };

    if (context !== undefined) entry.context = context;
    if (stack !== undefined) entry.stack = stack;

    const requestId = currentRequestId();
    if (requestId !== undefined) entry.requestId = requestId;

    // One line, always. A multi-line write is several Cloud Logging entries,
    // and the one carrying the stack is then the one without the severity.
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}

/** A readable message, whatever Nest was handed. */
function textOf(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;

  try {
    return JSON.stringify(message);
  } catch {
    // A circular object, which `JSON.stringify` throws on. Losing the detail
    // is acceptable; losing the log line is not.
    return String(message);
  }
}

/** The stack, when the thing logged was an error rather than a sentence. */
function stackOf(message: unknown): string | undefined {
  return message instanceof Error ? message.stack : undefined;
}
