/* =====================================================================
   auth.js — módulo compartilhado de login/sessão para o Caderno IA
   Usado por caderno-ia.html e admin.html.
   Same-origin: o backend serve estes arquivos estáticos, então a API
   fica em caminhos relativos (ex.: /api/login).
===================================================================== */
(function (global) {
  const TOKEN_KEY = 'cadernoia_token';
  const DEVICE_KEY = 'cadernoia_device_id';

  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  async function apiFetch(path, options) {
    options = options || {};
    const headers = Object.assign({}, options.headers || {});
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, Object.assign({}, options, { headers }));
    if (res.status === 401) {
      clearToken();
      throw Object.assign(new Error('Sessão expirada. Faça login novamente.'), { code: 'UNAUTHORIZED' });
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* corpo vazio */ }
    if (!res.ok) {
      const msg = (data && data.error) || ('Erro na requisição (' + res.status + ')');
      throw Object.assign(new Error(msg), { code: (data && data.code) || null, status: res.status });
    }
    return data;
  }

  async function login(username, password) {
    const data = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, deviceId: getDeviceId() })
    });
    setToken(data.token);
    return data.user;
  }

  async function fetchMe() {
    return apiFetch('/api/me');
  }

  async function logout() {
    try { await apiFetch('/api/logout', { method: 'POST' }); } catch (e) { /* ignora erro de rede no logout */ }
    clearToken();
  }

  global.CadernoAuth = { getDeviceId, getToken, setToken, clearToken, apiFetch, login, fetchMe, logout };
})(window);
