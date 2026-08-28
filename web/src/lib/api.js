/** Thin fetch wrapper. Studio calls rely on the HttpOnly session cookie. */

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    ...options,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.detail || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  publicAgents: () => request("/api/agents"),
  publicAgent: (slug) => request(`/api/agents/${encodeURIComponent(slug)}`),

  authMethods: () => request("/api/studio/auth-methods"),

  login: (password, name) =>
    request("/api/studio/login", {
      method: "POST",
      body: JSON.stringify({ password, name }),
    }),
  logout: () => request("/api/studio/logout", { method: "POST" }),
  session: () => request("/api/studio/session"),

  studioAgents: () => request("/api/studio/agents"),
  createAgent: (payload) =>
    request("/api/studio/agents", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateAgent: (slug, payload) =>
    request(`/api/studio/agents/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteAgent: (slug) =>
    request(`/api/studio/agents/${encodeURIComponent(slug)}`, { method: "DELETE" }),
};
