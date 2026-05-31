(function configureApiBase() {
  const PROD_API_BASE = "https://api-qf37m5ba2q-an.a.run.app";
  const LOCAL_API_BASE = "http://127.0.0.1:3001";
  const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const params = new URLSearchParams(window.location.search);
  const explicitApiBase = window.__DIFFSENSE_API_BASE__ || params.get("apiBase");
  const forceLocalApi = params.get("localApi") === "1";

  if (explicitApiBase) {
    window.API_BASE = String(explicitApiBase).replace(/\/$/, "");
    return;
  }

  if (isLocalHost && forceLocalApi) {
    window.API_BASE = LOCAL_API_BASE;
    return;
  }

  window.API_BASE = PROD_API_BASE;
})();

if (!window.API_BASE) {
  console.error("API_BASE is not defined");
}
