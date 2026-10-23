import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersModule } from '../orders/orders.module';
import { StockModule } from '../stock/stock.module';
import { OnlineOrderPlacementService } from './online-order-placement.service';

/**
 * Online Orders (plan §4.4, §5.4). From C7-3, the web order a confirmed
 * payment writes (`OnlineOrderPlacementService`), which `PaymentsModule`
 * calls inside its settle transaction. The staff commands and reads
 * (C7-4) join it here.
 */
@Module({
  imports: [AuditModule, OrdersModule, StockModule, CustomersModule],
  providers: [OnlineOrderPlacementService],
  exports: [OnlineOrderPlacementService],
})
export class OnlineOrdersModule {}
