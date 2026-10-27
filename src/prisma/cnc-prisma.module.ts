import { Global, Module } from '@nestjs/common';
import { CncPrismaService } from './cnc-prisma.service';

/**
 * Provides the single Prisma client to the whole service.
 *
 * Global so that one connection pool serves the whole process. A second
 * instance would open a second pool against the same database for no benefit,
 * and on the shared staging instance every connection counts (see the pool
 * comment in `cnc-prisma.service.ts`).
 */
@Global()
@Module({
  providers: [CncPrismaService],
  exports: [CncPrismaService],
})
export class CncPrismaModule {}
