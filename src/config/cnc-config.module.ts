import { Global, Module } from '@nestjs/common';
import { CncConfigService } from './cnc.config';

/**
 * Provides the one `CncConfigService` to every module.
 *
 * Global so that a feature module cannot accidentally construct a second
 * instance with its own `providers: [CncConfigService]`: the constructor runs
 * the boot rules, and they should run once per process.
 */
@Global()
@Module({
  providers: [CncConfigService],
  exports: [CncConfigService],
})
export class CncConfigModule {}
