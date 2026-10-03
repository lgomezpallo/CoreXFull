import { Router, type IRouter } from "express";
import {
  ExtractWebReferenceBody,
  ExtractWebReferenceResponse,
  ActivateBuilderModuleBody,
  ActivateBuilderModuleResponse,
  BuilderConversationBody,
  GenerateDiscussedBlueprintBody,
  GenerateAppBlueprintResponse,
} from "@workspace/api-zod";
import { generateBlueprintInTasks } from "../lib/builder-orchestrator";
import { converseAboutApp } from "../lib/builder-conversation";
import { extractWebReference } from "../lib/web-reference";
import { getValidatedAppModule } from "../lib/validated-app-modules";
import { requireSupabaseUser } from "../lib/supabase-auth";

const router: IRouter = Router();
router.use(requireSupabaseUser);

router.post("/builder/reference-url", async (req, res): Promise<void> => {
  const parsed = ExtractWebReferenceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Pegá una dirección web válida." });
    return;
  }

  try {
    const reference = await extractWebReference(parsed.data.url);
    const validated = ExtractWebReferenceResponse.safeParse(reference);
    if (!validated.success) {
      req.log.error({ validationError: validated.error.message }, "Extracted webpage did not match the API contract");
      res.status(502).json({ error: "No pude preparar esa página como referencia." });
      return;
    }
    res.json(validated.data);
  } catch (error) {
    req.log.warn({ err: error }, "Web reference extraction failed");
    res.status(422).json({
      error: error instanceof Error
        ? error.message
        : "No pude leer esa página pública. Revisá el enlace e intentá de nuevo.",
    });
  }
});

router.post("/builder/converse", async (req, res): Promise<void> => {
  const parsed = BuilderConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "No pude leer ese mensaje. Probá de nuevo." });
    return;
  }
  try {
    res.json(await converseAboutApp(parsed.data));
  } catch (error) {
    req.log.error({ err: error }, "Builder conversation failed");
    res.status(502).json({ error: "No pude responder ahora. Tu conversación sigue guardada; probá de nuevo." });
  }
});

router.post("/builder/generate", async (req, res): Promise<void> => {
  const parsed = GenerateDiscussedBlueprintBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Contame en pocas palabras qué querés crear." });
    return;
  }

  const { prompt, previousBlueprint, history, referenceFiles, designBrief } = parsed.data;
  try {
    const generatedPayload = await generateBlueprintInTasks({
      userId: req.authenticatedUserId!,
      accessToken: req.supabaseAccessToken!,
      prompt,
      designBrief,
      previousBlueprint,
      history,
      referenceFiles,
    });
    const generated = GenerateAppBlueprintResponse.safeParse(generatedPayload);
    if (!generated.success) {
      req.log.warn(
        { validationError: generated.error.message },
        "Generated app blueprint did not match the API contract",
      );
      res.status(502).json({
        error: "No pude armar una vista previa con ese pedido. Probá describirla de otra forma.",
      });
      return;
    }

    res.json(generated.data);
  } catch (error) {
    req.log.error({ err: error }, "App blueprint generation failed");
    res.status(502).json({
      error: "Ahora no pude generar la app. Intentá de nuevo en un momento.",
    });
  }
});

router.post("/builder/activate-module", async (req, res): Promise<void> => {
  const parsed = ActivateBuilderModuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "La aprobación no corresponde a un módulo válido." });
    return;
  }

  const { moduleId, blueprint, expansionProposal } = parsed.data;
  const module = getValidatedAppModule(moduleId);
  const approvedOption = expansionProposal.options.find((option) => option.moduleId === moduleId);
  if (
    !module ||
    blueprint.appKind !== "prototype" ||
    expansionProposal.status !== "approval-required" ||
    !approvedOption ||
    approvedOption.appKind !== module.appKind ||
    approvedOption.runtimeCost !== 0
  ) {
    res.status(400).json({ error: "Solo se pueden activar módulos validados que aparezcan en la propuesta." });
    return;
  }

  const activated = ActivateBuilderModuleResponse.safeParse({
    blueprint: { ...blueprint, appKind: module.appKind },
    module: {
      ...module,
      reason: module.summary,
      recommended: approvedOption.recommended,
    },
  });
  if (!activated.success) {
    req.log.warn(
      { validationError: activated.error.message },
      "Validated app module activation did not match the API contract",
    );
    res.status(500).json({ error: "No pude activar el módulo validado." });
    return;
  }

  res.json(activated.data);
});

export default router;