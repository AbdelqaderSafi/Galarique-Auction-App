-- Add a dedicated main/cover image, drop authenticity & country.
-- Temp default keeps the ADD safe if any rows already exist, then it is removed.
ALTER TABLE "Object" ADD COLUMN "mainImage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Object" ALTER COLUMN "mainImage" DROP DEFAULT;

ALTER TABLE "Object" DROP COLUMN "authenticity";
ALTER TABLE "Object" DROP COLUMN "country";
