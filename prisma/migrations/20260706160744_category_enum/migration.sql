-- Convert Category from a table to an enum.
-- Order matters: drop the table (which owns the implicit "Category" row type)
-- BEFORE creating the enum of the same name.

-- 1) Drop the FK, index and old column that reference the Category table
ALTER TABLE "Object" DROP CONSTRAINT "Object_categoryId_fkey";
DROP INDEX "Object_categoryId_idx";
ALTER TABLE "Object" DROP COLUMN "categoryId";

-- 2) Drop the Category table (frees the "Category" type name)
DROP TABLE "Category";

-- 3) Create the Category enum
CREATE TYPE "Category" AS ENUM ('ART', 'WATCHES', 'COLLECTIBLES', 'JEWELRY', 'FURNITURE', 'BOOKS', 'FASHION', 'ELECTRONICS');

-- 4) Add the enum column + index (Object table is empty, so NOT NULL is safe)
ALTER TABLE "Object" ADD COLUMN "category" "Category" NOT NULL;
CREATE INDEX "Object_category_idx" ON "Object"("category");
