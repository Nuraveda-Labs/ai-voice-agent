// Reconciliation: close orphaned CallAttempt rows that were left open by the
// pre-#13 handleFailure() bug. For each open attempt whose corresponding
// ScheduledCall is already terminal (status in done/failed), copy the
// scheduled call's outcome onto the attempt and stamp endedAt = the
// scheduledCall.updatedAt (best available approximation of when the
// failure was actually decided).
//
// Idempotent — running twice is a no-op (only acts on endedAt IS NULL).
// Defaults to a dry-run; pass --apply to write.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

(async () => {
  const open = await prisma.callAttempt.findMany({
    where: { endedAt: null },
    orderBy: { startedAt: 'asc' },
  });

  if (!open.length) {
    console.log('No open CallAttempts. Nothing to reconcile.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${open.length} open CallAttempt(s). Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  let acted = 0, skipped = 0;
  for (const a of open) {
    const sc = await prisma.scheduledCall.findUnique({
      where: { shop_orderId: { shop: a.shop, orderId: a.orderId } },
    });
    if (!sc) {
      console.log(`SKIP attempt=${a.id} ${a.orderName} — no matching ScheduledCall (data drift)`);
      skipped++;
      continue;
    }
    if (sc.status !== 'done' && sc.status !== 'failed') {
      console.log(`SKIP attempt=${a.id} ${a.orderName} — ScheduledCall still ${sc.status}, not terminal yet`);
      skipped++;
      continue;
    }
    const disposition = sc.outcome || (sc.status === 'failed' ? 'no_answer' : 'unknown');
    const endedAt = sc.updatedAt || new Date();
    const notes = a.notes
      || `reconciled by close-orphan-call-attempts.mjs from ScheduledCall.outcome=${sc.outcome} status=${sc.status}`;

    console.log(`${APPLY ? 'CLOSE' : 'WOULD-CLOSE'} attempt=${a.id} ${a.orderName} (${a.shop}) → disposition=${disposition} endedAt=${endedAt.toISOString()}`);
    if (APPLY) {
      await prisma.callAttempt.update({
        where: { id: a.id },
        data: { endedAt, disposition, notes },
      });
    }
    acted++;
  }

  console.log(`\nDone. ${APPLY ? 'Closed' : 'Would close'}: ${acted}. Skipped: ${skipped}.`);
  if (!APPLY) console.log('Re-run with --apply to commit.');
  await prisma.$disconnect();
})();
