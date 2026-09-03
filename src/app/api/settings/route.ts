import { getSettings, maskTaxId, saveSettings } from "@/lib/settings";
import { body, failed, ok } from "@/lib/http";
import type { Settings } from "@/lib/types";

export const runtime = "nodejs";

/** The tax id is masked on the way out and never returned in full. */
export async function GET() {
  try {
    const settings = await getSettings();
    return ok({ ...settings, entityTaxId: maskTaxId(settings.entityTaxId) });
  } catch (error) {
    return failed(error, "The settings could not be read.");
  }
}

export async function PUT(request: Request) {
  try {
    const patch = (await body(request)) as Partial<Settings>;
    const saved = await saveSettings(patch);
    return ok({ ...saved, entityTaxId: maskTaxId(saved.entityTaxId) });
  } catch (error) {
    return failed(error, "The settings could not be saved.");
  }
}
