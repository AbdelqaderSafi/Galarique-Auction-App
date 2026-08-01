import type { DatabaseService } from '../../src/modules/database/database.service';

/**
 * يصفّر كل الجداول (عدا جدول الـ migrations) بين ملفات/سيناريوهات الاختبار،
 * حتى تبقى كل حالة اختبار معزولة عن سابقاتها بلا الحاجة لإعادة تشغيل الـ migrations.
 *
 * حارس أمان (نفس حارس scripts/reset-system-test-db.ts): يرفض العمل إلا إذا كان
 * رابط الاتصال يشير بوضوح لقاعدة "test". بدونه، غياب ملف .env.test (وهو مُتجاهَل
 * بـ git) يجعل ConfigModule يحمّل .env — أي رابط Neon الإنتاجي — فيمسح بيانات
 * فريق الموبايل بالكامل.
 */
export async function resetDatabase(prisma: DatabaseService): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to TRUNCATE a database whose URL doesn't look like a test DB. ` +
        `Check that .env.test exists and DATABASE_URL points at galleryq_test. Got: ${
          url ? `${url.slice(0, 40)}...` : '(empty)'
        }`,
    );
  }

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;
  if (tables.length === 0) return;

  const names = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE;`);
}
