import {
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import { VersionedWriteDto } from '../src/common/dto/versioned-write.dto';
import {
  IdempotencyKey,
  IdempotentRoute,
  type IdempotencyRequest,
} from '../src/idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../src/idempotency/idempotency-scope';
import { IdempotencyService } from '../src/idempotency/idempotency.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { claimVersion } from '../src/prisma/optimistic-version';

/**
 * Test-only routes over `StockItem`, the first versioned table with no
 * required parents, for the optimistic-version and idempotency e2e suites.
 *
 * Mounted only by those suites, through `createTestApp({ controllers })`;
 * the service never registers it. Each route does what a real command will:
 * one transaction, `claimVersion` first for an edit, `IdempotencyService`
 * around a create. `holdMs` keeps the transaction open after the claim (or
 * the command) so two requests are guaranteed to overlap, instead of
 * overlapping by luck.
 */

export const PROBE_PATH = 'test-probes/stock-items';

/** Responses carry this header when the body was replayed, for the tests. */
export const REPLAYED_HEADER = 'x-probe-replayed';

/** Which caller a probe request is, standing in for the signed-in subject. */
export const SCOPE_HEADER = 'x-probe-scope';

class CreateProbeItemDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  factor!: number;

  @IsOptional()
  @IsBoolean()
  refuse?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3000)
  holdMs?: number;
}

class UpdateProbeItemDto extends VersionedWriteDto {
  @IsInt()
  @Min(0)
  minimum!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3000)
  holdMs?: number;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

@Controller(PROBE_PATH)
export class StockItemProbeController {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(201)
  @IdempotentRoute()
  async create(
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() body: CreateProbeItemDto,
    @Headers(SCOPE_HEADER) caller: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(caller ?? 'probe'),
      status: 201,
      work: async (tx) => {
        const item = await tx.stockItem.create({
          data: {
            name: body.name,
            kind: 'KITCHEN',
            unit: 'portion',
            pack: 'pack',
            factor: body.factor,
            minimum: 0,
          },
        });

        if (body.holdMs) await pause(body.holdMs);

        if (body.refuse) throw new ConflictException('The probe refused.');

        return {
          id: item.id,
          name: item.name,
          version: item.version,
          createdAt: item.createdAt,
        };
      },
    });

    response.setHeader(REPLAYED_HEADER, String(result.replayed));

    return result.body;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateProbeItemDto,
  ): Promise<{ id: string; minimum: number; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const version = await claimVersion(tx, {
        table: 'StockItem',
        id,
        version: body.version,
        notFound: 'Stock item not found.',
      });

      if (body.holdMs) await pause(body.holdMs);

      const item = await tx.stockItem.update({
        where: { id },
        data: { minimum: body.minimum },
      });

      return { id, minimum: item.minimum, version };
    });
  }
}
