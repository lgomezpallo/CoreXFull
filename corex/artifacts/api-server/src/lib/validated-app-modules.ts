export type ValidatedAppModuleId = "tasks-v1" | "habits-v1" | "expenses-v1";
export type FunctionalAppKind = "tasks" | "habits" | "expenses";

export type ValidatedAppModule = {
  moduleId: ValidatedAppModuleId;
  appKind: FunctionalAppKind;
  name: string;
  version: string;
  summary: string;
  capabilities: string[];
  limitations: string[];
  runtimeCost: 0;
};

const LOCAL_ONLY_LIMITATIONS = [
  "Los datos se guardan solo en este navegador.",
  "No incluye cuentas, sincronización ni servicios externos.",
];

export const VALIDATED_APP_MODULES: Record<ValidatedAppModuleId, ValidatedAppModule> = {
  "tasks-v1": {
    moduleId: "tasks-v1",
    appKind: "tasks",
    name: "Organizador de tareas",
    version: "1.0.0",
    summary: "Lista funcional para crear, editar, borrar y completar tareas.",
    capabilities: [
      "Crear, editar, borrar y completar tareas",
      "Agregar una fecha opcional",
      "Guardar los cambios en este navegador",
    ],
    limitations: [...LOCAL_ONLY_LIMITATIONS],
    runtimeCost: 0,
  },
  "habits-v1": {
    moduleId: "habits-v1",
    appKind: "habits",
    name: "Seguimiento de hábitos",
    version: "1.0.0",
    summary: "Registro diario de hábitos con avance y racha.",
    capabilities: [
      "Crear y borrar hábitos",
      "Registrar el avance de cada día",
      "Consultar el progreso diario y la racha",
    ],
    limitations: [...LOCAL_ONLY_LIMITATIONS],
    runtimeCost: 0,
  },
  "expenses-v1": {
    moduleId: "expenses-v1",
    appKind: "expenses",
    name: "Control de gastos",
    version: "1.0.0",
    summary: "Registro de gastos con categorías, fechas y totales mensuales.",
    capabilities: [
      "Crear, editar y borrar gastos",
      "Guardar concepto, monto, categoría y fecha",
      "Calcular totales del mes",
    ],
    limitations: [...LOCAL_ONLY_LIMITATIONS],
    runtimeCost: 0,
  },
};

export function isValidatedAppModuleId(value: unknown): value is ValidatedAppModuleId {
  return typeof value === "string" && Object.hasOwn(VALIDATED_APP_MODULES, value);
}

export function getValidatedAppModule(value: unknown): ValidatedAppModule | null {
  return isValidatedAppModuleId(value) ? VALIDATED_APP_MODULES[value] : null;
}