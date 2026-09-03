import { generateAllForms, generateForm, getForm, listForms, renderFormMarkdown } from "@/lib/forms";
import { activePeriod, preparer } from "@/lib/settings";
import { bad, body, failed, ok, str } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * The drafts.
 *
 * Nothing here can produce anything but a draft, and that is a property of the
 * type rather than of this route: `FormDraft.status` is the literal `"draft"`,
 * so there is no value a handler could set to mean otherwise even by mistake.
 */
export async function GET(request: Request) {
  try {
    const period = await activePeriod();
    const formId = new URL(request.url).searchParams.get("formId");

    if (formId) {
      const draft = await getForm(period.id, formId);
      if (!draft) {
        return bad(
          `No draft of ${formId} has been generated for ${period.label} yet. ` +
            `POST to this route to generate one.`,
          404,
        );
      }
      return ok({ draft, markdown: renderFormMarkdown(draft) });
    }

    return ok({ period, drafts: await listForms(period.id) });
  } catch (error) {
    return failed(error, "The drafts could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    const payload = await body(request).catch(() => ({}) as Record<string, unknown>);
    const period = await activePeriod();
    const actor = preparer();
    const formId = str(payload.formId);

    const drafts = formId
      ? [await generateForm(formId, period.id, actor)]
      : await generateAllForms(period.id, actor);

    return ok({ generated: drafts.length, drafts });
  } catch (error) {
    if (error instanceof Error && /unknown form|no such form/i.test(error.message)) {
      return bad(error.message);
    }
    return failed(error, "The drafts could not be generated.");
  }
}
