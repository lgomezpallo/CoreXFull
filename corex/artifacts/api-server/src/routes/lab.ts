import { AnalyzeLabProjectBody, AnalyzeLabProjectResponse } from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import { analyzeLabEvidence } from "../lib/lab-analysis";
import { requireSupabaseUser } from "../lib/supabase-auth";

const router: IRouter = Router();

router.use(requireSupabaseUser);

router.post("/lab/analyze", async (req, res): Promise<void> => {
  const input = AnalyzeLabProjectBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }

  try {
    const analysis = await analyzeLabEvidence(input.data, req.authenticatedUserId!, req.supabaseAccessToken!);
    const result = AnalyzeLabProjectResponse.safeParse(analysis);
    if (!result.success) {
      req.log.error({ validationError: result.error.message }, "Lab analysis response did not match the API contract");
      res.status(502).json({ error: "Router IA devolvió un análisis con un formato no válido." });
      return;
    }
    res.json(result.data);
  } catch (error) {
    req.log.error({ err: error }, "Could not analyze imported software evidence");
    res.status(502).json({
      error: error instanceof Error
        ? error.message.slice(0, 240)
        : "No pude analizar el material con Router IA.",
    });
  }
});

export default router;