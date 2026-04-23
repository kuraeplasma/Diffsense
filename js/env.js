window.API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? "http://localhost:3001"
  : "https://api-qf37m5ba2q-an.a.run.app";

if (!window.API_BASE) {
  console.error("API_BASE is not defined");
}
