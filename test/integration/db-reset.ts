import type { DatabaseService } from '../../src/modules/database/database.service';

/**
 * يصفّر كل الجداول (عدا جدول الـ migrations) بين ملفات/سيناريوهات الاختبار،
 * حتى تبقى كل حالة اختبار معزولة عن سابقاتها بلا الحاجة لإعادة تشغيل الـ migrations.
 */
export async function resetDatabase(prisma: DatabaseService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;
  if (tables.length === 0) return;

  const names = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE;`);
}
