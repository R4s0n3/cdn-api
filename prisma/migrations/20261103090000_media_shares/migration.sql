-- AlterTable
ALTER TABLE "File" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "MediaShare" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaShareFile" (
    "shareId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "fileUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaShareFile_pkey" PRIMARY KEY ("shareId","fileId")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaShare_tokenHash_key" ON "MediaShare"("tokenHash");

-- CreateIndex
CREATE INDEX "MediaShare_createdAt_idx" ON "MediaShare"("createdAt");

-- CreateIndex
CREATE INDEX "MediaShareFile_fileId_idx" ON "MediaShareFile"("fileId");

-- AddForeignKey
ALTER TABLE "MediaShareFile" ADD CONSTRAINT "MediaShareFile_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "MediaShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaShareFile" ADD CONSTRAINT "MediaShareFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
