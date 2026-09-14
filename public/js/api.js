const pendingRequests = new Map();

const api = {
  async request(method, url, body) {
    const key = `${method}:${url}:${body ? JSON.stringify(body) : ''}`;
    if (pendingRequests.has(key)) return pendingRequests.get(key);

    const request = (async () => {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (res.status === 401) {
        window.location.href = '/login.html';
        throw new Error('No autenticado');
      }
      if (!res.ok) {
        throw new Error((data && data.error) || 'Error inesperado');
      }
      return data;
    })();

    pendingRequests.set(key, request);
    try {
      return await request;
    } finally {
      if (pendingRequests.get(key) === request) pendingRequests.delete(key);
    }
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  patch(url, body) { return this.request('PATCH', url, body); },
};

function fmtMoney(n) {
  return '$' + Math.round(n).toLocaleString('es-CO');
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
