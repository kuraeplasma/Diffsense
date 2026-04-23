(function configureApiBase() {
  const PROD_API_BASE = "https://api-qf37m5ba2q-an.a.run.app";
  const LOCAL_API_BASE = "http://localhost:3001";
  const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const params = new URLSearchParams(window.location.search);
  const explicitApiBase = window.__DIFFSENSE_API_BASE__ || params.get("apiBase");
  const forceProdApi = params.get("prodApi") === "1";

  if (explicitApiBase) {
    window.API_BASE = String(explicitApiBase).replace(/\/$/, "");
    return;
  }

  // Localhost ではローカルAPIを既定にする（CORS回避）。
  // 本番APIを使う場合のみ ?prodApi=1 を付与する。
  window.API_BASE = (isLocalHost && !forceProdApi) ? LOCAL_API_BASE : PROD_API_BASE;
})();

if (!window.API_BASE) {
  console.error("API_BASE is not defined");
}
