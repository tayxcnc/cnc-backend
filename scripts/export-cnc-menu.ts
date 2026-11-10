/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import * as fs from 'fs';
import * as path from 'path';
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
      'Usage: ts-node scripts/export-cnc-menu.ts [--url="postgresql://..."]',
    );
    process.exit(1);
  }
  return envUrl;
}

async function main() {
  const connectionString = getDbUrl();
  const maskedUrl = connectionString.replace(/:([^:@]+)@/, ':****@');
  console.log(`🔌 Connecting to CNC database: ${maskedUrl}`);

  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log(
      '📦 Fetching menu categories, staff categories, and menu items...',
    );

    // 1. MenuCategory
    const menuCatRes = await client.query(`
      SELECT id, "createdAt", "updatedAt", slug, title, note, kind, sort
      FROM "MenuCategory"
      ORDER BY sort ASC;
    `);

    // 2. StaffCategory
    const staffCatRes = await client.query(`
      SELECT id, "createdAt", "updatedAt", name, department, "menuCategoryId"
      FROM "StaffCategory"
      ORDER BY name ASC;
    `);

    // 3. MenuItem
    const menuItemRes = await client.query(`
      SELECT 
        id, "createdAt", "updatedAt", slug, "legacyStaffId", department,
        "staffCategoryId", "menuCategoryId", "groupLabel", name, description,
        "priceKobo", signature, active, "showOnline", photo, "photoThumb",
        "photoAlt", "choiceLabel", "choiceOptions", sort, version
      FROM "MenuItem"
      ORDER BY "menuCategoryId" ASC, sort ASC;
    `);

    // 4. Paired StockItem (for Bar drinks)
    const stockItemRes = await client.query(`
      SELECT 
        id, "createdAt", "updatedAt", name, kind, unit, pack, factor,
        minimum, "menuItemId", active, version
      FROM "StockItem"
      WHERE "menuItemId" IS NOT NULL;
    `);

    const menuItems = menuItemRes.rows;
    const menuCategories = menuCatRes.rows;
    const staffCategories = staffCatRes.rows;
    const pairedStockItems = stockItemRes.rows;

    console.log(`✅ Retrieved ${menuCategories.length} menu categories.`);
    console.log(`✅ Retrieved ${staffCategories.length} staff categories.`);
    console.log(`✅ Retrieved ${menuItems.length} menu items.`);
    console.log(
      `✅ Retrieved ${pairedStockItems.length} paired Bar stock items.`,
    );

    const backupPayload = {
      exportedAt: new Date().toISOString(),
      database: maskedUrl,
      counts: {
        menuCategories: menuCategories.length,
        staffCategories: staffCategories.length,
        menuItems: menuItems.length,
        pairedStockItems: pairedStockItems.length,
      },
      menuCategories,
      staffCategories,
      menuItems,
      pairedStockItems,
    };

    const backupsDir = path.resolve(__dirname, '../backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const timestampedFile = path.join(
      backupsDir,
      `cnc-menu-backup-${timestamp}.json`,
    );
    const latestFile = path.join(backupsDir, 'cnc-menu-backup-latest.json');

    fs.writeFileSync(
      timestampedFile,
      JSON.stringify(backupPayload, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      latestFile,
      JSON.stringify(backupPayload, null, 2),
      'utf-8',
    );

    console.log(
      '\n================ CNC FOOD & DRINK MENU BACKUP SUMMARY ================',
    );
    console.log(`📁 Saved to: ${timestampedFile}`);
    console.log(`📁 Symlink/Latest: ${latestFile}`);
    console.log(`🍽️ Total Menu Items backed up: ${menuItems.length}`);
    console.log(
      '----------------------------------------------------------------------',
    );

    // Show top sample items by category
    const catMap = new Map(menuCategories.map((c) => [c.id, c.title]));
    for (const item of menuItems.slice(0, 15)) {
      const priceNaira = (item.priceKobo / 100).toLocaleString('en-NG', {
        style: 'currency',
        currency: 'NGN',
      });
      const catName = catMap.get(item.menuCategoryId) || 'Unknown';
      console.log(
        ` • [${catName}] ${item.name} - ${priceNaira} (Active: ${item.active}, Online: ${item.showOnline})`,
      );
    }
    if (menuItems.length > 15) {
      console.log(` ... and ${menuItems.length - 15} more menu items.`);
    }

    console.log(
      '======================================================================\n',
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Failed to export CNC menu:', err);
  process.exit(1);
});
