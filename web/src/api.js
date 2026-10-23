import axios from 'axios';

const TOKEN_KEY = 'printgate_token';

export const api = axios.create({ baseURL: '/api', timeout: 60000 });

api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  (r) => r.data,
  (err) => {
    const status = err.response?.status;
    const data = err.response?.data || {};
    if (status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      if (!location.hash.includes('/login')) window.dispatchEvent(new CustomEvent('pg:unauthorized'));
    }
    const msg = data.msg || (err.code === 'ECONNABORTED' ? '请求超时，请重试' : '网络异常，请检查服务是否运行');
    return Promise.reject(Object.assign(new Error(msg), { status, data }));
  }
);

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (v) => localStorage.setItem(TOKEN_KEY, v),
  clear: () => localStorage.removeItem(TOKEN_KEY)
};

export const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const fmtDuration = (sec) => {
  const s = Number(sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
};

export const STATUS_META = {
  pending: { text: '待审批', type: 'warning' },
  approved: { text: '已批准', type: 'info' },
  printing: { text: '打印中', type: 'info' },
  done: { text: '已完成', type: 'success' },
  failed: { text: '失败', type: 'error' },
  rejected: { text: '已拒绝', type: 'error' },
  canceled: { text: '已取消', type: 'default' }
};

export const USER_STATUS = {
  pending: { text: '待审批', type: 'warning' },
  approved: { text: '已授权', type: 'success' },
  rejected: { text: '已拒绝', type: 'error' },
  blocked: { text: '已拉黑', type: 'default' }
};
