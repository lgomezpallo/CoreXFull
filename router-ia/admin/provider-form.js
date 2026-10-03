const knownProviders = {
  groq: {
    label: "Groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  openrouter: {
    label: "OpenRouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  openai: {
    label: "OpenAI",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
  },
  nvidia: {
    label: "NVIDIA NIM",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  cloudflare: {
    label: "Cloudflare Workers AI",
    name: "Cloudflare Workers AI",
  },
  custom: {
    label: "Personalizado",
  },
};

const form = document.querySelector("#provider-form");
const nameInput = document.querySelector("#provider-name");
const baseUrlInput = document.querySelector("#base-url");
const apiKeyInput = document.querySelector("#api-key");

if (form && nameInput && baseUrlInput && apiKeyInput) {
  const nameLabel = document.querySelector('label[for="provider-name"]');
  const baseUrlLabel = document.querySelector('label[for="base-url"]');
  const baseHint = baseUrlInput.nextElementSibling;

  const selectorLabel = document.createElement("label");
  selectorLabel.htmlFor = "provider-type";
  selectorLabel.textContent = "Proveedor";

  const selector = document.createElement("select");
  selector.id = "provider-type";
  selector.name = "providerType";
  selector.required = true;
  for (const [value, provider] of Object.entries(knownProviders)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = provider.label;
    selector.append(option);
  }
  selector.value = "cloudflare";

  const accountLabel = document.createElement("label");
  accountLabel.htmlFor = "cloudflare-account-id";
  accountLabel.textContent = "Account ID";

  const accountInput = document.createElement("input");
  accountInput.id = "cloudflare-account-id";
  accountInput.name = "accountId";
  accountInput.autocomplete = "off";
  accountInput.spellcheck = false;
  accountInput.placeholder = "32 caracteres";
  accountInput.maxLength = 64;

  const accountHint = document.createElement("p");
  accountHint.className = "field-hint";
  accountHint.textContent = "El Router arma automáticamente la URL y lee todo el catálogo de Workers AI.";

  nameLabel.parentNode.insertBefore(selectorLabel, nameLabel);
  nameLabel.parentNode.insertBefore(selector, nameLabel);
  nameLabel.parentNode.insertBefore(accountLabel, nameLabel);
  nameLabel.parentNode.insertBefore(accountInput, nameLabel);
  nameLabel.parentNode.insertBefore(accountHint, nameLabel);

  function setVisible(element, visible) {
    if (element) element.hidden = !visible;
  }

  function syncForm() {
    const type = selector.value;
    const custom = type === "custom";
    const cloudflare = type === "cloudflare";

    setVisible(accountLabel, cloudflare);
    setVisible(accountInput, cloudflare);
    setVisible(accountHint, cloudflare);
    accountInput.required = cloudflare;

    setVisible(nameLabel, custom);
    setVisible(nameInput, custom);
    setVisible(baseUrlLabel, custom);
    setVisible(baseUrlInput, custom);
    setVisible(baseHint, custom);
    nameInput.required = custom;
    baseUrlInput.required = custom;

    if (!custom && !cloudflare) {
      nameInput.value = knownProviders[type].name;
      baseUrlInput.value = knownProviders[type].baseUrl;
    }
    if (cloudflare) {
      nameInput.value = knownProviders.cloudflare.name;
      const accountId = accountInput.value.trim();
      baseUrlInput.value = accountId
        ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`
        : "";
    }
  }

  selector.addEventListener("change", syncForm);
  accountInput.addEventListener("input", syncForm);
  form.addEventListener("submit", (event) => {
    syncForm();
    if (selector.value === "cloudflare" && !/^[A-Za-z0-9_-]{16,64}$/.test(accountInput.value.trim())) {
      event.preventDefault();
      event.stopImmediatePropagation();
      accountInput.setCustomValidity("Ingresá un Account ID válido de Cloudflare.");
      accountInput.reportValidity();
      return;
    }
    accountInput.setCustomValidity("");
  }, true);

  syncForm();
}
