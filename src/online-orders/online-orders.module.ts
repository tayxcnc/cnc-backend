import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { CustomerNotificationsModule } from '../customer-notifications/customer-notifications.module';
import { CustomersModule } from '../customers/customers.module';
import { MailModule } from '../mail/mail.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { OrdersModule } from '../orders/orders.module';
import { PaystackClientModule } from '../payments/paystack-client.module';
import { PushModule } from '../push/push.module';
import { StockModule } from '../stock/stock.module';
import { CustomerOrdersController } from './customer-orders.controller';
import { CustomerOrdersService } from './customer-orders.service';
import { OnlineOrderMail } from './online-order-mail';
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
 *
 * From C7-6, the customer's messages about an order (`OnlineOrderMail`:
 * the receipt, the stage changes, the refunds, by email and in the in-app
 * list) and the customer's own orders (`GET /me/orders`,
 * `CustomerOrdersService`).
 *
 * From C10, the web pushes of those events (`PushModule`): the customer's
 * stage and refund pushes beside the in-app items, and the staff's new
 * web order and web docket pushes beside the placement and the edits.
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
    MailModule,
    CustomerNotificationsModule,
    PushModule,
  ],
  controllers: [OnlineOrdersController, CustomerOrdersController],
  providers: [
    OnlineOrderPlacementService,
    OnlineOrdersService,
    OnlineRefundsService,
    OnlineOrderMail,
    CustomerOrdersService,
  ],
  exports: [OnlineOrderPlacementService],
})
export class OnlineOrdersModule {}
