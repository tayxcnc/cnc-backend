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
    console.error('❌ Error: CNC_DB_URL is not set.');
    process.exit(1);
  }
  return envUrl;
}

async function main() {
  const fileArg = process.argv.find((arg) => arg.startsWith('--file='));
  const backupFilePath = fileArg
    ? fileArg.replace('--file=', '')
    : path.resolve(__dirname, '../backups/cnc-menu-backup-latest.json');

  if (!fs.existsSync(backupFilePath)) {
    console.error(`❌ Backup file not found at: ${backupFilePath}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(backupFilePath, 'utf-8');
  const backup = JSON.parse(rawData);

  const { menuCategories, staffCategories, menuItems, pairedStockItems } =
    backup;

  console.log(`📦 Loaded from backup:`);
  console.log(` • ${menuCategories?.length || 0} menu categories`);
  console.log(` • ${staffCategories?.length || 0} staff categories`);
  console.log(` • ${menuItems?.length || 0} menu items`);
  console.log(` • ${pairedStockItems?.length || 0} paired stock items`);

  const connectionString = getDbUrl();
  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log('🚀 Restoring menu data in order...');

    // 1. MenuCategory
    if (menuCategories && menuCategories.length > 0) {
      for (const c of menuCategories) {
        await client.query(
          `
          INSERT INTO "MenuCategory" (id, "createdAt", "updatedAt", slug, title, note, kind, sort)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            slug = EXCLUDED.slug,
            title = EXCLUDED.title,
            note = EXCLUDED.note,
            kind = EXCLUDED.kind,
            sort = EXCLUDED.sort,
            "updatedAt" = NOW();
        `,
          [
            c.id,
            c.createdAt || new Date(),
            c.updatedAt || new Date(),
            c.slug,
            c.title,
            c.note,
            c.kind,
            c.sort,
          ],
        );
      }
      console.log(` ✅ Restored ${menuCategories.length} menu categories.`);
    }

    // 2. StaffCategory
    if (staffCategories && staffCategories.length > 0) {
      for (const sc of staffCategories) {
        await client.query(
          `
          INSERT INTO "StaffCategory" (id, "createdAt", "updatedAt", name, department, "menuCategoryId")
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            department = EXCLUDED.department,
            "menuCategoryId" = EXCLUDED."menuCategoryId",
            "updatedAt" = NOW();
        `,
          [
            sc.id,
            sc.createdAt || new Date(),
            sc.updatedAt || new Date(),
            sc.name,
            sc.department,
            sc.menuCategoryId,
          ],
        );
      }
      console.log(` ✅ Restored ${staffCategories.length} staff categories.`);
    }

    // 3. MenuItem
    if (menuItems && menuItems.length > 0) {
      for (const m of menuItems) {
        await client.query(
          `
          INSERT INTO "MenuItem" (
            id, "createdAt", "updatedAt", slug, "legacyStaffId", department,
            "staffCategoryId", "menuCategoryId", "groupLabel", name, description,
            "priceKobo", signature, active, "showOnline", photo, "photoThumb",
            "photoAlt", "choiceLabel", "choiceOptions", sort, version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
          ON CONFLICT (id) DO UPDATE SET
            slug = EXCLUDED.slug,
            "legacyStaffId" = EXCLUDED."legacyStaffId",
            department = EXCLUDED.department,
            "staffCategoryId" = EXCLUDED."staffCategoryId",
            "menuCategoryId" = EXCLUDED."menuCategoryId",
            "groupLabel" = EXCLUDED."groupLabel",
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            "priceKobo" = EXCLUDED."priceKobo",
            signature = EXCLUDED.signature,
            active = EXCLUDED.active,
            "showOnline" = EXCLUDED."showOnline",
            photo = EXCLUDED.photo,
            "photoThumb" = EXCLUDED."photoThumb",
            "photoAlt" = EXCLUDED."photoAlt",
            "choiceLabel" = EXCLUDED."choiceLabel",
            "choiceOptions" = EXCLUDED."choiceOptions",
            sort = EXCLUDED.sort,
            version = EXCLUDED.version,
            "updatedAt" = NOW();
        `,
          [
            m.id,
            m.createdAt || new Date(),
            m.updatedAt || new Date(),
            m.slug,
            m.legacyStaffId,
            m.department,
            m.staffCategoryId,
            m.menuCategoryId,
            m.groupLabel,
            m.name,
            m.description,
            m.priceKobo,
            m.signature,
            m.active,
            m.showOnline,
            m.photo,
            m.photoThumb,
            m.photoAlt,
            m.choiceLabel,
            m.choiceOptions || [],
            m.sort,
            m.version || 0,
          ],
        );
      }
      console.log(` ✅ Restored ${menuItems.length} menu items.`);
    }

    // 4. Paired StockItem
    if (pairedStockItems && pairedStockItems.length > 0) {
      for (const s of pairedStockItems) {
        await client.query(
          `
          INSERT INTO "StockItem" (
            id, "createdAt", "updatedAt", name, kind, unit, pack, factor,
            minimum, "menuItemId", active, version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            kind = EXCLUDED.kind,
            unit = EXCLUDED.unit,
            pack = EXCLUDED.pack,
            factor = EXCLUDED.factor,
            minimum = EXCLUDED.minimum,
            "menuItemId" = EXCLUDED."menuItemId",
            active = EXCLUDED.active,
            version = EXCLUDED.version,
            "updatedAt" = NOW();
        `,
          [
            s.id,
            s.createdAt || new Date(),
            s.updatedAt || new Date(),
            s.name,
            s.kind,
            s.unit,
            s.pack,
            s.factor,
            s.minimum,
            s.menuItemId,
            s.active,
            s.version || 0,
          ],
        );
      }
      console.log(
        ` ✅ Restored ${pairedStockItems.length} paired Bar stock items.`,
      );
    }

    console.log('\n🎉 Successfully restored all menu data from backup!');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Restore failed:', err);
  process.exit(1);
});
