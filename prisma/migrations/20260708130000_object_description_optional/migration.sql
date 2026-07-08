-- Object.description becomes optional (the create wizard may not collect it).
ALTER TABLE "Object" ALTER COLUMN "description" DROP NOT NULL;
