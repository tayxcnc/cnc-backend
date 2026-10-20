import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** First page, when the caller does not say. */
export const DEFAULT_PAGE = 1;

/** Rows per page, when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Largest page a caller may ask for.
 *
 * Not a performance guard so much as a blast-radius one: without a ceiling,
 * `pageSize=100000` is a single request that materialises an entire table in
 * memory and serialises it.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * The `page` and `pageSize` half of a paginated query string, for routes that
 * want twenty rows a page and a ceiling of a hundred. The response is
 * `{ data, page, pageSize, total }` (plan A5).
 *
 * The numbers here are a default that suits a table of rows, not a
 * project-wide rule, so a route wanting different ones should say so in its
 * own file rather than widen these.
 *
 * `@Type(() => Number)` is doing real work. Query parameters arrive as
 * strings, and the global ValidationPipe runs with `transform: true`, so
 * without it `@IsInt` would reject `?page=2` — the value is `'2'`, which is
 * not an integer.
 *
 * Extend this and add whatever else the route filters by; the inherited
 * decorators carry into the derived class's OpenAPI schema unchanged.
 */
export class PaginationQuery {
  @ApiPropertyOptional({
    description: 'One-based page number.',
    minimum: 1,
    default: DEFAULT_PAGE,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be an integer.' })
  @Min(1, { message: 'page must be 1 or greater.' })
  page?: number;

  @ApiPropertyOptional({
    description: 'Rows per page.',
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize must be an integer.' })
  @Min(1, { message: 'pageSize must be 1 or greater.' })
  @Max(MAX_PAGE_SIZE, {
    message: `pageSize must be ${MAX_PAGE_SIZE} or fewer.`,
  })
  pageSize?: number;
}
