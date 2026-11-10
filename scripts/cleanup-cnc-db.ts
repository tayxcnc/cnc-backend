/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Client } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

function getDbUrl(): string {
  const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
  if (urlArg) {
    return urlArg.replace('--url=', '');
  }
  const envUrl = process.env.CNC_DB_URL;
  if (!envUrl) {
    console.error(
      '❌ Error: CNC_DB_URL is not set and no --url argument was provided.',
    );
    console.error(
      'Usage: ts-node scripts/cleanup-cnc-db.ts [--url="postgresql://..."] [--dry-run] [--force]',
    );
    process.exit(1);
  }
  return envUrl;
}

const TABLES_TO_TRUNCATE = [
  // Till, Orders & Kitchen (Menu and categories are preserved!)
  'Order',
  'OrderLine',
  'Docket',
  'Payment',
  'CashCount',
  'KitchenEntry',
  'KitchenDayClosed',

  // Tables & Reservations
  'Reservation',
  'TableSession',

  // Customers & Auth
  'Customer',
  'OtpCode',
  'RefreshToken',
  'PasswordResetToken',

  // Stock movements, balances & purchases (StockItem catalog preserved)
  'StockBalance',
  'StockMovement',
  'StockRequest',
  'PurchaseLine',
  'Purchase',
  'WasteEntry',

  // Attendance
  'AttendanceCorrection',
  'AttendanceRecord',

  // Audits & Logs (Protected by triggers, bypassed during truncate)
  'ApprovalLedger',
  'AuditLog',

  // Notifications & Messages
  'CustomerNotification',
  'OutboundMessage',
  'CustomerPushSubscription',
  'StaffPushSubscription',
  'PushMessage',
  'Enquiry',

  // Online orders & Checkouts
  'OnlineAdjustment',
  'OnlineRefund',
  'OnlineOrder',
  'Checkout',

  // Events, keys, rates
  'PaymentEvent',
  'IdempotencyKey',
  'RateLimitCount',

  // Tasks & Maintenance
  'TaskHistory',
  'Task',
  'MaintenanceHistory',
  'MaintenanceRecord',
];

const TABLES_PRESERVED = [
  'MenuItem', // <--- YOUR FOOD & DRINK DISHES
  'MenuCategory', // <--- YOUR MENU CATEGORIES
  'StaffCategory', // <--- YOUR STAFF CATEGORIES
  'StockItem', // <--- Paired bar stock
  'KitchenMapping',
  'Settings',
  'Business',
  'OpeningHoursDay',
  'Venue',
  'DiningTable',
  'Staff',
  'Vendor',
  'Asset',
];

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const isForce = process.argv.includes('--force');

  const connectionString = getDbUrl();
  const maskedUrl = connectionString.replace(/:([^:@]+)@/, ':****@');
  console.log(`🔌 Connecting to CNC database: ${maskedUrl}`);

  if (!isForce && !isDryRun) {
    console.error(
      '\n⚠️  SAFETY WARNING: This will delete transactional data from the database.',
    );
    console.error(
      'To run in preview mode without deleting anything, add: --dry-run',
    );
    console.error('To actually perform the cleanup, add: --force\n');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log('\n📊 Checking current database counts before cleanup...\n');

    // Get count of preserved tables
    const preservedCounts: Record<string, number> = {};
    for (const table of TABLES_PRESERVED) {
      try {
        const res = await client.query(
          `SELECT COUNT(*) as count FROM "${table}"`,
        );
        preservedCounts[table] = parseInt(res.rows[0].count, 10);
      } catch {
        preservedCounts[table] = 0;
      }
    }

    // Get count of transactional tables to be wiped
    const wipedCounts: Record<string, number> = {};
    for (const table of TABLES_TO_TRUNCATE) {
      try {
        const res = await client.query(
          `SELECT COUNT(*) as count FROM "${table}"`,
        );
        wipedCounts[table] = parseInt(res.rows[0].count, 10);
      } catch {
        wipedCounts[table] = 0;
      }
    }

    console.log('--- PRESERVED DATA (WILL NOT BE TOUCHED) ---');
    for (const [table, count] of Object.entries(preservedCounts)) {
      const tag = table === 'MenuItem' ? ' ⭐ [CRITICAL FOOD MENU]' : '';
      console.log(` • "${table}": ${count} rows${tag}`);
    }

    console.log('\n--- TRANSACTIONAL DATA (WILL BE WIPED) ---');
    let totalWipedRows = 0;
    for (const [table, count] of Object.entries(wipedCounts)) {
      if (count > 0) {
        console.log(` • "${table}": ${count} rows`);
        totalWipedRows += count;
      }
    }
    if (totalWipedRows === 0) {
      console.log(' • All transactional tables are already empty (0 rows).');
    } else {
      console.log(` Total transactional rows to clear: ${totalWipedRows}`);
    }

    if (isDryRun) {
      console.log('\n🔍 [DRY RUN COMPLETE] No data was modified.');
      console.log('To execute the cleanup, run with --force');
      return;
    }

    console.log('\n🚀 Starting cleanup in a single transaction...');
    await client.query('BEGIN');

    // 1. Temporarily disable immutability triggers on append-only tables
    console.log('🔓 Temporarily disabling user immutability triggers...');
    await client.query(
      'ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only_row";',
    );
    await client.query(
      'ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only_truncate";',
    );
    await client.query(
      'ALTER TABLE "StockMovement" DISABLE TRIGGER "StockMovement_append_only_row";',
    );
    await client.query(
      'ALTER TABLE "StockMovement" DISABLE TRIGGER "StockMovement_append_only_truncate";',
    );
    await client.query(
      'ALTER TABLE "ApprovalLedger" DISABLE TRIGGER "ApprovalLedger_append_only_row";',
    );
    await client.query(
      'ALTER TABLE "ApprovalLedger" DISABLE TRIGGER "ApprovalLedger_append_only_truncate";',
    );
    try {
      await client.query(
        'ALTER TABLE "ApprovalLedger" DISABLE TRIGGER "ApprovalLedger_release_shape";',
      );
    } catch {
      // Ignore if doesn't exist
    }

    // 2. Truncate all transactional tables with CASCADE
    console.log('🧹 Truncating transactional tables...');
    const tableListSql = TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(', ');
    await client.query(`TRUNCATE TABLE ${tableListSql} CASCADE;`);

    // 3. Re-enable immutability triggers
    console.log('🔒 Re-enabling user immutability triggers...');
    await client.query(
      'ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_append_only_row";',
    );
    await client.query(
      'ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_append_only_truncate";',
    );
    await client.query(
      'ALTER TABLE "StockMovement" ENABLE TRIGGER "StockMovement_append_only_row";',
    );
    await client.query(
      'ALTER TABLE "StockMovement" ENABLE TRIGGER "StockMovement_append_only_truncate";',
    );
    await client.query(
      'ALTER TABLE "ApprovalLedger" ENABLE TRIGGER "ApprovalLedger_append_only_row";',
    );
    await client.query(
      'ALTER TABLE "ApprovalLedger" ENABLE TRIGGER "ApprovalLedger_append_only_truncate";',
    );
    try {
      await client.query(
        'ALTER TABLE "ApprovalLedger" ENABLE TRIGGER "ApprovalLedger_release_shape";',
      );
    } catch {
      // Ignore
    }

    // 4. Reset sequences if they exist
    try {
      await client.query(
        `ALTER SEQUENCE IF EXISTS order_no_seq RESTART WITH 1;`,
      );
    } catch {
      // Ignore
    }

    await client.query('COMMIT');
    console.log('✅ Cleanup transaction successfully committed!');

    // Post-cleanup verification
    console.log('\n🔎 Verifying post-cleanup state...');
    const postMenuItemRes = await client.query(
      'SELECT COUNT(*) as count FROM "MenuItem"',
    );
    const postMenuItemCount = parseInt(postMenuItemRes.rows[0].count, 10);

    const postCatRes = await client.query(
      'SELECT COUNT(*) as count FROM "MenuCategory"',
    );
    const postCatCount = parseInt(postCatRes.rows[0].count, 10);

    const postOrderRes = await client.query(
      'SELECT COUNT(*) as count FROM "Order"',
    );
    const postOrderCount = parseInt(postOrderRes.rows[0].count, 10);

    const postCustomerRes = await client.query(
      'SELECT COUNT(*) as count FROM "Customer"',
    );
    const postCustomerCount = parseInt(postCustomerRes.rows[0].count, 10);

    console.log(
      ` • Food Menu Items: ${postMenuItemCount} (Was: ${preservedCounts['MenuItem']})`,
    );
    console.log(
      ` • Menu Categories: ${postCatCount} (Was: ${preservedCounts['MenuCategory']})`,
    );
    console.log(` • Orders: ${postOrderCount}`);
    console.log(` • Customers: ${postCustomerCount}`);

    if (postMenuItemCount === preservedCounts['MenuItem']) {
      console.log(
        '\n🎉 SUCCESS! All food menu items preserved, test data completely cleared.',
      );
    } else {
      console.error(
        '\n⚠️ WARNING: MenuItem count discrepancy detected! Please check your backup.',
      );
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Transaction rolled back due to error:', err);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ CNC database cleanup failed:', err);
  process.exit(1);
});
