-- AlterTable
ALTER TABLE "CallAttempt" ADD COLUMN     "audioDurationMs" INTEGER,
ADD COLUMN     "audioFormat" TEXT,
ADD COLUMN     "audioSampleRate" INTEGER,
ADD COLUMN     "audioUri" TEXT,
ADD COLUMN     "consentGiven" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lang" TEXT,
ADD COLUMN     "turnCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CallTurn" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" VARCHAR(64) NOT NULL,
    "roomName" TEXT NOT NULL,
    "sipCallId" TEXT,
    "turnIndex" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "toolName" TEXT,
    "toolArgs" JSONB,
    "toolResult" TEXT,
    "lang" TEXT,
    "sttConfidence" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallTurn_shop_orderId_idx" ON "CallTurn"("shop", "orderId");

-- CreateIndex
CREATE INDEX "CallTurn_roomName_turnIndex_idx" ON "CallTurn"("roomName", "turnIndex");

-- CreateIndex
CREATE INDEX "CallTurn_createdAt_idx" ON "CallTurn"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallTurn_roomName_turnIndex_key" ON "CallTurn"("roomName", "turnIndex");

-- CreateIndex
CREATE INDEX "CallAttempt_disposition_createdAt_idx" ON "CallAttempt"("disposition", "createdAt");

