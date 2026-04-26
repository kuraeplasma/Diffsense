(function configureApiBase() {
  const PROD_API_BASE = "https://api-qf37m5ba2q-an.a.run.app";
  const h = window.location.hostname;
  const isLocal = h === "localhost" || h === "127.0.0.1" || h.startsWith("192.168.") || h.startsWith("10.") || h.startsWith("172.");
  const localBase = (h.startsWith("192.168.") || h.startsWith("10.") || h.startsWith("172.")) 
    ? `http://${h}:3001` 
    : "http://localhost:3001";

  const params = new URLSearchParams(window.location.search);
  const explicitApiBase = window.__DIFFSENSE_API_BASE__ || params.get("apiBase");
  const forceProdApi = params.get("prodApi") === "1";

  if (explicitApiBase) {
    window.API_BASE = String(explicitApiBase).replace(/\/$/, "");
    return;
  }

  // ローカルバックエンド（localhost:3001）は存在しないため、ローカルでも本番APIを使用する。
  // ローカルバックエンドが必要な場合は ?apiBase=http://localhost:3001 で明示指定すること。
  window.API_BASE = PROD_API_BASE;
})();

if (!window.API_BASE) {
  console.error("API_BASE is not defined");
}
