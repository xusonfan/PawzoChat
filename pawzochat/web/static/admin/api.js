const base = globalThis.window?.PAWZOCHAT_BASE || "";

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    credentials: "same-origin",
    headers: options.body instanceof FormData
      ? options.headers
      : { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 401) {
    window.location.href = `${base}/admin/login`;
    throw new Error("管理员登录已失效");
  }
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.blob();
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { data, response };
}

export const api = {
  get: path => request(path).then(result => result.data),
  post: (path, data) => request(path, {
    method: "POST",
    body: data instanceof FormData ? data : JSON.stringify(data),
  }).then(result => result.data),
  put: (path, data) => request(path, { method: "PUT", body: JSON.stringify(data) }).then(result => result.data),
  del: path => request(path, { method: "DELETE" }).then(result => result.data),
  download: async (path, data, fallbackName) => {
    const { data: blob, response } = await request(path, { method: "POST", body: JSON.stringify(data) });
    const disposition = response.headers.get("content-disposition") || "";
    const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const filename = utf8 ? decodeURIComponent(utf8[1]) : fallbackName;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  },
};