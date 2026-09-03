import { clearLedger, importLedgerCsv, listLedger } from "@/lib/ledger";
import { activePeriod, preparer } from "@/lib/settings";
import { bad, body, failed, ok, str } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    const period = await activePeriod();
    return ok({ currency: period.currency, entries: await listLedger(period.id) });
  } catch (error) {
    return failed(error, "The ledger could not be read.");
  }
}

/**
 * Import a ledger export.
 *
 * `problems` comes back populated rather than swallowed. A row that would not
 * parse is a row of the accounts that is now missing from the reconciliation,
 * and an import reporting "34 imported" while silently dropping four is how a
 * period reconciles cleanly against books it does not actually match.
 */
export async function POST(request: Request) {
  try {
    const payload = await body(request);
    const csv = str(payload.csv);
    if (!csv) return bad('Send the ledger export as a "csv" string.');

    const period = await activePeriod();
    return ok(await importLedgerCsv(csv, period.id, preparer()));
  } catch (error) {
    return failed(error, "The ledger could not be imported.");
  }
}

export async function DELETE() {
  try {
    const period = await activePeriod();
    return ok({ cleared: await clearLedger(period.id, preparer()) });
  } catch (error) {
    return failed(error, "The ledger could not be cleared.");
  }
}
