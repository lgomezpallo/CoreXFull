const CONTROL_TOPIC = /\b(?:licen[cs](?:e|ia|ing)?|drm|autenticaci[oó]n|authentication|pago|payment|paywall|premium|control(?:es)? de acceso|access control)\b/i;
const RESTRICTED_ACTION = /\b(?:bypass|circumvent|evad(?:ir|e|iendo)|elud(?:ir|e|iendo)|salt(?:ear|arse)|desbloque(?:ar|o)|quitar|remove|disable|crack(?:ear)?|piratear|sin pagar|gratis|free|without paying|without authorization|sin autorizaci[oó]n)\b/i;

export function requestsProtectedControlEvasion(goal: string): boolean {
  return CONTROL_TOPIC.test(goal) && RESTRICTED_ACTION.test(goal);
}

export const LAB_RESTRICTED_OPERATION_MESSAGE =
  "No se generará código ni instrucciones para evadir licencias, DRM, autenticación, pagos o controles de acceso.";