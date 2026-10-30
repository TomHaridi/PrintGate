// 服务地址三环境矩阵
// current 决定默认 BASE；部署到不同环境时改这一行即可。
// 「我的 → 服务地址」里手改的地址优先级最高，存放在 Storage（pg_base_url）。
const current = 'dev';

const ENVS = {
  dev: {
    name: '本地联调',
    baseUrl: 'http://127.0.0.1:8080',
    desc: 'Docker 本机运行 PrintGate 的默认地址（开发者工具需关闭域名校验）'
  },
  staging: {
    name: '预发环境',
    baseUrl: '',
    desc: '部署到 staging 服务器后填写，例如 https://printgate-staging.example.com'
  },
  prod: {
    name: '生产环境',
    baseUrl: '',
    desc: '正式对外地址，必须是已备案 https 域名'
  }
};

module.exports = {
  current,
  env: ENVS[current] || ENVS.dev,
  ENVS
};
