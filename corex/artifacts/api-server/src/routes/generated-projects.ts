import { Router, type IRouter } from "express";
import {
  CreateBuilderProjectBuildBody,
  CreateBuilderProjectBuildParams,
  CreateBuilderProjectBuildResponse,
  CreateBuilderProjectJobBody,
  CreateBuilderProjectJobParams,
  CreateBuilderProjectJobResponse,
  GetBuilderProjectJobParams,
  GetBuilderProjectJobResponse,
  GetBuilderProjectJobStatusParams,
  GetBuilderProjectJobStatusResponse,
  ReportBuilderProjectRuntimeCheckBody,
  ReportBuilderProjectRuntimeCheckParams,
  ReportBuilderProjectRuntimeCheckResponse,
} from "@workspace/api-zod";
import {
  GeneratedProjectJobConflictError,
  GeneratedProjectJobInputError,
  readGeneratedProjectJob,
  reportGeneratedProjectRuntimeCheck,
  startGeneratedProjectBuild,
  startGeneratedProjectJob,
} from "../lib/generated-project-jobs";
import { requireSupabaseUser } from "../lib/supabase-auth";

const router: IRouter = Router();

router.use(requireSupabaseUser);

function authenticatedUserId(req: Express.Request): string | null {
  return req.authenticatedUserId ?? null;
}

router.post("/builder/projects/:projectId/jobs", (req, res): void => {
  const params = CreateBuilderProjectJobParams.safeParse(req.params);
  const body = CreateBuilderProjectJobBody.safeParse(req.body);
  const ownerId = authenticatedUserId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Iniciá sesión para generar un proyecto." });
    return;
  }
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Revisá el pedido y los archivos antes de generar el proyecto." });
    return;
  }

  try {
    const job = startGeneratedProjectJob({
      ownerId,
      userId: ownerId,
      accessToken: req.supabaseAccessToken!,
      projectId: params.data.projectId,
      ...body.data,
    });
    const validated = CreateBuilderProjectJobResponse.safeParse(job);
    if (!validated.success) {
      req.log.error(
        { validationError: validated.error.message },
        "Created generated-project job did not match the API contract",
      );
      res.status(500).json({ error: "No pude iniciar el trabajo de generación." });
      return;
    }
    res.status(201).json(validated.data);
  } catch (error) {
    if (error instanceof GeneratedProjectJobConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof GeneratedProjectJobInputError) {
      res.status(400).json({
        error: error.diagnostics[0] || "Los archivos actuales del proyecto no son válidos.",
        diagnostics: error.diagnostics,
      });
      return;
    }
    req.log.error({ err: error }, "Could not start generated-project job");
    res.status(500).json({ error: "No pude iniciar el trabajo de generación." });
  }
});

router.post("/builder/projects/:projectId/builds", (req, res): void => {
  const params = CreateBuilderProjectBuildParams.safeParse(req.params);
  const body = CreateBuilderProjectBuildBody.safeParse(req.body);
  const ownerId = authenticatedUserId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Iniciá sesión para compilar un proyecto." });
    return;
  }
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Los archivos guardados no son válidos para compilar." });
    return;
  }

  try {
    const job = startGeneratedProjectBuild({
      ownerId,
      userId: ownerId,
      accessToken: req.supabaseAccessToken!,
      projectId: params.data.projectId,
      ...body.data,
    });
    const validated = CreateBuilderProjectBuildResponse.safeParse(job);
    if (!validated.success) {
      req.log.error(
        { validationError: validated.error.message },
        "Created generated-project build did not match the API contract",
      );
      res.status(500).json({ error: "No pude iniciar la compilación." });
      return;
    }
    res.status(201).json(validated.data);
  } catch (error) {
    if (error instanceof GeneratedProjectJobConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof GeneratedProjectJobInputError) {
      res.status(400).json({
        error: "Los archivos guardados no son válidos para compilar.",
        diagnostics: error.diagnostics,
      });
      return;
    }
    req.log.error({ err: error }, "Could not start generated-project build");
    res.status(500).json({ error: "No pude iniciar la compilación." });
  }
});

router.get("/builder/project-jobs/:jobId", (req, res): void => {
  const params = GetBuilderProjectJobParams.safeParse(req.params);
  const ownerId = authenticatedUserId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Iniciá sesión para consultar el proyecto." });
    return;
  }
  if (!params.success) {
    res.status(404).json({ error: "No encontré ese trabajo de proyecto." });
    return;
  }
  const job = readGeneratedProjectJob(params.data.jobId, ownerId);
  if (!job) {
    res.status(404).json({ error: "No encontré ese trabajo de proyecto." });
    return;
  }
  const validated = GetBuilderProjectJobResponse.safeParse(job);
  if (!validated.success) {
    req.log.error(
      { validationError: validated.error.message },
      "Read generated-project job did not match the API contract",
    );
    res.status(500).json({ error: "No pude leer el estado de la compilación." });
    return;
  }
  res.json(validated.data);
});

router.get("/builder/project-jobs/:jobId/status", (req, res): void => {
  const params = GetBuilderProjectJobStatusParams.safeParse(req.params);
  const ownerId = authenticatedUserId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Iniciá sesión para consultar el proyecto." });
    return;
  }
  if (!params.success) {
    res.status(404).json({ error: "No encontré ese trabajo de proyecto." });
    return;
  }
  const job = readGeneratedProjectJob(params.data.jobId, ownerId);
  if (!job) {
    res.status(404).json({ error: "No encontré ese trabajo de proyecto." });
    return;
  }
  const validated = GetBuilderProjectJobStatusResponse.safeParse({
    id: job.id,
    projectId: job.projectId,
    stage: job.stage,
    statusMessage: job.statusMessage,
    plannedFiles: job.plannedFiles,
    generatedFiles: job.generatedFiles,
    fileProgress: job.fileProgress,
    correctedFiles: job.correctedFiles,
    codingFallbackUsed: job.codingFallbackUsed,
    codingEscalationFiles: job.codingEscalationFiles,
    diagnostics: job.diagnostics,
    previewReady: Boolean(job.previewHtml),
    error: job.error,
    attempt: job.attempt,
    updatedAt: job.updatedAt,
  });
  if (!validated.success) {
    req.log.error(
      { validationError: validated.error.message },
      "Generated-project status did not match the API contract",
    );
    res.status(500).json({ error: "No pude leer el estado de la compilación." });
    return;
  }
  res.json(validated.data);
});

router.post("/builder/project-jobs/:jobId/runtime-check", (req, res): void => {
  const params = ReportBuilderProjectRuntimeCheckParams.safeParse(req.params);
  const body = ReportBuilderProjectRuntimeCheckBody.safeParse(req.body);
  const ownerId = authenticatedUserId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Iniciá sesión para validar la vista previa." });
    return;
  }
  if (!params.success || !body.success) {
    res.status(400).json({ error: "El resultado de la prueba no es válido." });
    return;
  }

  try {
    const job = reportGeneratedProjectRuntimeCheck(params.data.jobId, ownerId, body.data);
    if (!job) {
      res.status(404).json({ error: "No encontré ese trabajo de proyecto." });
      return;
    }
    const validated = ReportBuilderProjectRuntimeCheckResponse.safeParse(job);
    if (!validated.success) {
      req.log.error(
        { validationError: validated.error.message },
        "Runtime-checked project did not match the API contract",
      );
      res.status(500).json({ error: "No pude registrar la prueba de la vista previa." });
      return;
    }
    res.json(validated.data);
  } catch (error) {
    if (error instanceof GeneratedProjectJobConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Could not register generated-project runtime check");
    res.status(500).json({ error: "No pude registrar la prueba de la vista previa." });
  }
});

export default router;