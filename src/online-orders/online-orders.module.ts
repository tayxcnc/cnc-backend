import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { OrdersModule } from '../orders/orders.module';
import { PaystackClientModule } from '../payments/paystack-client.module';
import { StockModule } from '../stock/stock.module';
import { OnlineOrderPlacementService } from './online-order-placement.service';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';
import { OnlineRefundsService } from './online-refunds.service';

/**
 * Online Orders (plan §4.4, §5.4). From C7-3, the web order a confirmed
 * payment writes (`OnlineOrderPlacementService`), which `PaymentsModule`
 * calls inside its settle transaction. From C7-4, the staff screen's
 * commands and reads (`OnlineOrdersService`, `GET`/`POST
 * /staff/online-orders…`) and the card refunds sent through Paystack
 * (`OnlineRefundsService`, with the client from `PaystackClientModule`).
 *
 * The audit rows of every online command are filed under the bill's
 * `CNCR-` number, whose history reader `OrdersModule` registers.
 */
@Module({
  imports: [
    CncAuthModule,
    AuditModule,
    OrdersModule,
    StockModule,
    CustomersModule,
    MoneyControlModule,
    PaystackClientModule,
  ],
  controllers: [OnlineOrdersController],
  providers: [
    OnlineOrderPlacementService,
    OnlineOrdersService,
    OnlineRefundsService,
  ],
  exports: [OnlineOrderPlacementService],
})
export class OnlineOrdersModule {}
