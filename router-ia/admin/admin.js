const loginView = document.querySelector("#login-view");
const adminView = document.querySelector("#admin-view");
const loginForm = document.querySelector("#login-form");
const recoveryLogin = document.querySelector("#recovery-login");
const passkeyLoginPanel = document.querySelector("#passkey-login-panel");
const passkeyLoginButton = document.querySelector("#passkey-login-button");
const passkeySummary = document.querySelector("#passkey-summary");
const passkeyList = document.querySelector("#passkey-list");
const passkeyMessage = document.querySelector("#passkey-message");
const registerPasskeyButton = document.querySelector("#register-passkey-button");
const providerForm = document.querySelector("#provider-form");
const providerName = document.querySelector("#provider-name");
const baseUrl = document.querySelector("#base-url");
const apiKey = document.querySelector("#api-key");
const saveButton = document.querySelector("#save-button");
const logoutButton = document.querySelector("#logout-button");
const installButton = document.querySelector("#install-button");
const providersList = document.querySelector("#providers-list");
const routesList = document.querySelector("#routes-list");
const providerCount = document.querySelector("#provider-count");
const loginMessage = document.querySelector("#login-message");
const providerMessage = document.querySelector("#provider-message");
const globalMessage = document.querySelector("#global-message");

const capabilityLabels = {
  chat: "Chat",
  coding: "Código",
  reasoning: "Razonamiento",
  summarization: "Resumen",
  vision: "Visión",
  document: "Documentos",
  long_context: "Contexto largo",
  fast: "Rápido",
};

function setMessage(element, message, type = "") {
  element.textContent = message;
  element.classList.toggle("is-error", type === "error");
  element.classList.toggle("is-success", type === "success");
}

function supportsPasskeys() {
  return (
    window.isSecureContext &&
    "credentials" in navigator &&
    typeof navigator.credentials.get === "function" &&
    typeof navigator.credentials.create === "function" &&
    "PublicKeyCredential" in window
  );
}

function base64UrlToBuffer(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function bufferToBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function prepareCredentialOptions(options) {
  const prepared = {
    ...options,
    challenge: base64UrlToBuffer(options.challenge),
  };
  if (options.user) {
    prepared.user = { ...options.user, id: base64UrlToBuffer(options.user.id) };
  }
  for (const key of ["allowCredentials", "excludeCredentials"]) {
    if (Array.isArray(options[key])) {
      prepared[key] = options[key].map((credential) => ({
        ...credential,
        id: base64UrlToBuffer(credential.id),
      }));
    }
  }
  return prepared;
}

function serializeCredential(credential) {
  const response = credential.response;
  const serializedResponse = {
    clientDataJSON: bufferToBase64Url(response.clientDataJSON),
  };
  if ("attestationObject" in response) {
    serializedResponse.attestationObject = bufferToBase64Url(response.attestationObject);
    serializedResponse.transports = response.getTransports?.() ?? [];
  } else {
    serializedResponse.authenticatorData = bufferToBase64Url(response.authenticatorData);
    serializedResponse.signature = bufferToBase64Url(response.signature);
    serializedResponse.userHandle = response.userHandle
      ? bufferToBase64Url(response.userHandle)
      : null;
  }
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: serializedResponse,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Report a generic error if the server did not return JSON.
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "La solicitud no se pudo completar.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showLogin() {
  loginView.hidden = false;
  adminView.hidden = true;
  updatePasskeyLogin();
}

function showAdmin() {
  loginView.hidden = true;
  adminView.hidden = false;
  loadProviders();
  loadPasskeys();
}

async function updatePasskeyLogin() {
  passkeyLoginPanel.hidden = true;
  recoveryLogin.open = true;
  if (!supportsPasskeys()) {
    return;
  }
  try {
    const status = await api("/admin/api/passkeys/status");
    if (status.count > 0) {
      passkeyLoginPanel.hidden = false;
      recoveryLogin.open = false;
    }
  } catch {
    setMessage(
      loginMessage,
      "El acceso por dispositivo no está disponible ahora. Podés usar el token de recuperación.",
      "error",
    );
  }
}

async function loginWithPasskey() {
  setBusy(passkeyLoginButton, true, "Esperando al dispositivo…");
  setMessage(loginMessage, "");
  try {
    const { challengeId, options } = await api(
      "/admin/api/passkeys/login/options",
      { method: "POST", body: JSON.stringify({}) },
    );
    const credential = await navigator.credentials.get({
      publicKey: prepareCredentialOptions(options),
    });
    if (!credential) throw new Error("No se completó la verificación del dispositivo.");
    await api("/admin/api/passkeys/login/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId,
        response: serializeCredential(credential),
      }),
    });
    showAdmin();
  } catch (error) {
    setMessage(
      loginMessage,
      error.name === "NotAllowedError"
        ? "No se completó el desbloqueo. Probá otra vez o usá el token de recuperación."
        : error.message,
      "error",
    );
  } finally {
    setBusy(passkeyLoginButton, false);
  }
}

function renderPasskeys(credentials) {
  passkeyList.replaceChildren();
  for (const credential of credentials) {
    const item = document.createElement("li");
    item.className = "passkey-row";
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = credential.name || "Dispositivo";
    const date = document.createElement("span");
    date.className = "passkey-date";
    const createdAt = Date.parse(credential.createdAt);
    date.textContent = Number.isNaN(createdAt)
      ? ""
      : `Registrado el ${new Intl.DateTimeFormat("es-AR", {
          dateStyle: "medium",
        }).format(createdAt)}`;
    details.append(name, date);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "button button-quiet passkey-remove";
    removeButton.textContent = "Quitar";
    removeButton.addEventListener("click", () => removePasskey(credential.id));
    item.append(details, removeButton);
    passkeyList.append(item);
  }
}

async function loadPasskeys() {
  setMessage(passkeyMessage, "");
  try {
    const { credentials } = await api("/admin/api/passkeys");
    renderPasskeys(credentials);
    passkeySummary.textContent = credentials.length
      ? `${credentials.length} dispositivo${credentials.length === 1 ? "" : "s"} registrado${credentials.length === 1 ? "" : "s"}. El token sigue disponible para recuperar el acceso.`
      : "Todavía no hay un dispositivo registrado. Activá el acceso para usar la huella o el método de desbloqueo habitual.";
    registerPasskeyButton.disabled = !supportsPasskeys();
    if (!supportsPasskeys()) {
      setMessage(
        passkeyMessage,
        "Este navegador o conexión no permite passkeys. Abrí el panel en un navegador seguro para registrar el dispositivo.",
        "error",
      );
    }
  } catch (error) {
    passkeySummary.textContent = "No se pudo consultar el estado del acceso por dispositivo.";
    registerPasskeyButton.disabled = true;
    setMessage(passkeyMessage, error.message, "error");
  }
}

async function registerPasskey() {
  setBusy(registerPasskeyButton, true, "Esperando al dispositivo…");
  setMessage(passkeyMessage, "");
  try {
    const { challengeId, options } = await api(
      "/admin/api/passkeys/register/options",
      { method: "POST", body: JSON.stringify({}) },
    );
    const credential = await navigator.credentials.create({
      publicKey: prepareCredentialOptions(options),
    });
    if (!credential) throw new Error("No se completó el registro del dispositivo.");
    await api("/admin/api/passkeys/register/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId,
        name: "Dispositivo",
        response: serializeCredential(credential),
      }),
    });
    await loadPasskeys();
    setMessage(passkeyMessage, "Acceso directo activado en este dispositivo.", "success");
  } catch (error) {
    setMessage(
      passkeyMessage,
      error.name === "NotAllowedError"
        ? "No se completó el registro. Aceptá el desbloqueo del dispositivo e intentá otra vez."
        : error.message,
      "error",
    );
  } finally {
    setBusy(registerPasskeyButton, false);
  }
}

async function removePasskey(credentialId) {
  if (!window.confirm("¿Quitar este dispositivo? El token seguirá disponible como recuperación.")) {
    return;
  }
  try {
    await api(`/admin/api/passkeys/${encodeURIComponent(credentialId)}`, {
      method: "DELETE",
    });
    setMessage(passkeyMessage, "Dispositivo quitado.", "success");
    await loadPasskeys();
  } catch (error) {
    setMessage(passkeyMessage, error.message, "error");
  }
}

function getProviderPayload() {
  return {
    provider: "custom",
    name: providerName.value,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
  };
}

function setBusy(button, busy, busyLabel) {
  if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent.trim();
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.originalLabel;
}

function formatModelMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  const details = [];
  if (metadata.freePlanAccess === "groq_free_plan") {
    details.push("disponible en el plan Free de Groq (sujeto a cuotas)");
  }
  if (metadata.freePlanAccess === "nvidia_api_catalog_prototyping") {
    details.push("NVIDIA NIM para prototipos (sujeto a cuotas)");
  }
  if (Number.isSafeInteger(metadata.contextLength)) {
    details.push(`${new Intl.NumberFormat("es").format(metadata.contextLength)} tokens de contexto`);
  }
  if (metadata.inputModalities?.length) {
    details.push(`entrada: ${metadata.inputModalities.join(", ")}`);
  }
  if (metadata.outputModalities?.length) {
    details.push(`salida: ${metadata.outputModalities.join(", ")}`);
  }
  if (metadata.pricing && Object.keys(metadata.pricing).length) {
    const prices = Object.entries(metadata.pricing)
      .map(([key, value]) => `${key} ${value}`)
      .join(" · ");
    details.push(`precios publicados: ${prices}`);
  }
  return details.join(" · ");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function formatProviderMetadata(metadata) {
  const details = formatModelMetadata(metadata);
  return details ? escapeHtml(details) : "Sin metadatos publicados";
}

function renderProviders(providers) {
  providerCount.textContent = String(providers.length);
  if (providers.length === 0) {
    providersList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon" aria-hidden="true">＋</span>
        <strong>Todavía no hay proveedores</strong>
        <span>La configuración activa aparecerá acá.</span>
      </div>`;
    return;
  }

  providersList.innerHTML = providers
    .map((provider) => {
      const active = provider.active === true;
      const name = escapeHtml(provider.name || provider.provider);
      const model = escapeHtml(provider.model || "Sin modelo");
      const base = escapeHtml(provider.baseUrl || "");
      const id = escapeHtml(provider.id);
      const providerLabel =
        provider.provider === "custom" ? "API compatible" : escapeHtml(provider.provider);
      const capabilities = Array.isArray(provider.capabilities) ? provider.capabilities : [];
      const capabilityMarkup = capabilities.length
        ? capabilities
            .map(
              (capability) =>
                `<span class="capability-badge">${escapeHtml(capabilityLabels[capability] || capability)}</span>`,
            )
            .join("")
        : '<span class="provider-meta">Sin capacidades declaradas</span>';
      const checkedAt = provider.catalogCheckedAt
        ? new Date(provider.catalogCheckedAt).toLocaleDateString("es-AR")
        : "No registrado";
      return `
        <article class="provider-card${active ? " is-active" : ""}">
          <div class="provider-main">
            <div class="provider-title-row">
              <span class="provider-name">${name}</span>
              <span class="${active ? "active-label" : "inactive-label"}">${active ? "Activo" : "Inactivo"}</span>
            </div>
            <p class="provider-detail">${providerLabel} · ${model}<br>${base}</p>
            <div class="capability-badges">${capabilityMarkup}</div>
            <p class="provider-meta">Prioridad ${escapeHtml(provider.priority ?? 50)} · Catálogo: ${escapeHtml(checkedAt)}</p>
            <p class="provider-meta">${formatProviderMetadata(provider.modelMetadata)}</p>
          </div>
          <div class="provider-actions">
            <button class="small-action" type="button" data-action="${active ? "deactivate" : "activate"}" data-id="${id}">${active ? "Desactivar" : "Activar"}</button>
            <button class="small-action danger" type="button" data-action="delete" data-id="${id}" aria-label="Eliminar ${name}">Eliminar</button>
          </div>
        </article>`;
    })
    .join("");
}

function renderRoutes(routes) {
  const visibleRoutes = Array.isArray(routes)
    ? routes.filter((route) => Array.isArray(route.providers) && route.providers.length > 0)
    : [];
  if (visibleRoutes.length === 0) {
    routesList.innerHTML = '<p class="route-empty">Todavía no hay rutas activas.</p>';
    return;
  }

  routesList.innerHTML = visibleRoutes
    .map((route) => {
      const label = escapeHtml(capabilityLabels[route.capability] || route.capability);
      const providers = route.providers
        .map(
          (provider) =>
            `<li><span>${escapeHtml(provider.name)} · ${escapeHtml(provider.model)}</span><b>${escapeHtml(provider.priority)}</b></li>`,
        )
        .join("");
      return `<article class="route-card"><strong>${label}</strong><ol>${providers}</ol></article>`;
    })
    .join("");
}

async function loadProviders() {
  providersList.innerHTML = '<div class="loading-row"><span class="spinner"></span> Cargando configuración…</div>';
  try {
    const result = await api("/admin/api/providers");
    renderProviders(Array.isArray(result.providers) ? result.providers : []);
    renderRoutes(result.routes);
    globalMessage.hidden = true;
  } catch (error) {
    providersList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon" aria-hidden="true">!</span>
        <strong>No se pudo cargar la configuración</strong>
        <span>${escapeHtml(error.message)}</span>
      </div>`;
    globalMessage.textContent =
      error.status === 503
        ? "El panel ya está protegido, pero falta configurar el almacenamiento de proveedores en el servicio."
        : error.message;
    globalMessage.hidden = false;
  }
}

async function handleProviderAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (!id) return;

  if (action === "delete" && !window.confirm("¿Eliminar este proveedor guardado? Esta acción no se puede deshacer.")) {
    return;
  }
  button.disabled = true;
  try {
    await api(
      action === "activate"
        ? `/admin/api/providers/${encodeURIComponent(id)}/activate`
        : action === "deactivate"
          ? `/admin/api/providers/${encodeURIComponent(id)}/deactivate`
          : `/admin/api/providers/${encodeURIComponent(id)}`,
      { method: action === "delete" ? "DELETE" : "POST" },
    );
    globalMessage.hidden = true;
    await loadProviders();
  } catch (error) {
    globalMessage.textContent = error.message;
    globalMessage.hidden = false;
    button.disabled = false;
  }
}

providersList.addEventListener("click", handleProviderAction);

providerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(saveButton, true, "Consultando catálogo…");
  try {
    const result = await api("/admin/api/providers/add-free-models", {
      method: "POST",
      body: JSON.stringify(getProviderPayload()),
    });
    apiKey.value = "";
    providerName.value = "";
    baseUrl.value = "";

    const addedCount = Number(result.addedCount) || 0;
    const freeModelsFound = Number(result.freeModelsFound) || 0;
    const isGroqFreePlan = result.freePlanPolicy === "groq_free_plan";
    const groqFreePlanAddedCount = Number(result.groqFreePlanAddedCount) || 0;
    const groqFreePlanMatchedCount = Number(result.groqFreePlanMatchedCount) || 0;
    const isNvidiaCatalog = result.freePlanPolicy === "nvidia_api_catalog_prototyping";
    const nvidiaCatalogAddedCount = Number(result.nvidiaApiCatalogAddedCount) || 0;
    if (addedCount > 0) {
      const alreadyConfigured = Number(result.alreadyConfiguredCount) || 0;
      const duplicateMessage =
        alreadyConfigured > 0 ? ` ${alreadyConfigured} ya estaban agregados.` : "";
      let successMessage;
      if (isNvidiaCatalog && nvidiaCatalogAddedCount > 0) {
        successMessage = `Se agregaron ${addedCount} modelos de NVIDIA NIM para prototipos, sujetos a cuotas.${duplicateMessage} Router IA no ejecutó inferencias.`;
      } else if (groqFreePlanAddedCount > 0) {
        successMessage = `Se agregaron ${addedCount} modelos; ${groqFreePlanAddedCount} figuran en la lista de cuotas Free de Groq. Esos usos son gratuitos dentro de sus límites.${duplicateMessage} No se ejecutó inferencia.`;
      } else {
        successMessage = `Se agregaron ${addedCount} modelos con precio publicado de $0.${duplicateMessage} No se ejecutó inferencia.`;
      }
      setMessage(providerMessage, successMessage, "success");
    } else if (freeModelsFound > 0) {
      let alreadyAddedMessage;
      if (isNvidiaCatalog) {
        alreadyAddedMessage = "Los modelos de NVIDIA NIM para prototipos ya estaban agregados. No se duplicaron ni se reemplazaron sus claves.";
      } else if (isGroqFreePlan && groqFreePlanMatchedCount > 0) {
        alreadyAddedMessage = "Los modelos elegibles del plan Free de Groq ya estaban agregados. No se duplicaron ni se reemplazaron sus claves.";
      } else {
        alreadyAddedMessage = "Todos los modelos gratuitos encontrados ya estaban agregados. No se duplicaron ni se reemplazaron sus claves.";
      }
      setMessage(
        providerMessage,
        alreadyAddedMessage,
        "success",
      );
    } else {
      const found = Number(result.modelsFound) || 0;
      const unknownPricing = Number(result.unknownPricingCount) || 0;
      const unconfirmedModels = Number(result.unconfirmedModelsCount) || 0;
      let detail;
      if (found === 0) {
        detail = "El catálogo no publicó modelos disponibles.";
      } else if (isGroqFreePlan) {
        detail = `${unconfirmedModels} modelos no figuran en la lista de cuotas Free de Groq verificada el 02/10/2026 ni publican precio $0.`;
      } else {
        detail = `${unknownPricing} no publicaban precios suficientes para confirmar que fueran gratuitos.`;
      }
      setMessage(
        providerMessage,
        `No se guardó la API key porque no se confirmó ningún modelo gratuito. ${detail}`,
        "error",
      );
    }
    await loadProviders();
  } catch (error) {
    setMessage(providerMessage, error.message, "error");
  } finally {
    setBusy(saveButton, false);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const tokenInput = document.querySelector("#admin-token");
  const submitButton = loginForm.querySelector("button");
  setBusy(submitButton, true, "Validando…");
  setMessage(loginMessage, "");
  try {
    await api("/admin/api/session", {
      method: "POST",
      body: JSON.stringify({ token: tokenInput.value }),
    });
    tokenInput.value = "";
    showAdmin();
  } catch (error) {
    setMessage(loginMessage, error.message, "error");
    tokenInput.select();
  } finally {
    setBusy(submitButton, false);
  }
});

passkeyLoginButton.addEventListener("click", loginWithPasskey);
registerPasskeyButton.addEventListener("click", registerPasskey);

logoutButton.addEventListener("click", async () => {
  try {
    await api("/admin/api/session/logout", { method: "POST" });
  } finally {
    showLogin();
  }
});

let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  installButton.disabled = true;
  try {
    await promptEvent.prompt();
    await promptEvent.userChoice;
  } catch (error) {
    console.error("Router IA installation prompt failed.", error);
  } finally {
    installButton.hidden = true;
    installButton.disabled = false;
  }
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/admin/service-worker.js", { scope: "/admin/" })
    .catch((error) => console.error("Router IA service worker registration failed.", error));
}

api("/admin/api/session")
  .then((result) => (result.authenticated ? showAdmin() : showLogin()))
  .catch((error) => {
    showLogin();
    setMessage(loginMessage, error.message, "error");
  });