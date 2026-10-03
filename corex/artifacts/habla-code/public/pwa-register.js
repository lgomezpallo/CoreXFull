if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch((error) => console.warn("No se pudo activar la PWA.", error));
  });
}
