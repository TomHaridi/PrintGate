<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">中转对接</h1>
        <div class="page-desc">分步用内网穿透把 PrintGate 暴露到公网（单端口 443 推荐），并管理开放 API</div>
      </div>
      <div class="row wrap">
        <n-tag :bordered="false" size="small" type="info">{{ modeText }}</n-tag>
        <n-tag :type="st.relay?.enableFrp ? 'success' : 'default'" :bordered="false" size="small">
          frp {{ st.relay?.enableFrp ? '已启用' : '未启用' }}
        </n-tag>
        <n-tag :type="frpRunning ? 'success' : 'warning'" :bordered="false" size="small">
          {{ frpRunning ? '客户端在线' : '客户端未运行' }}
        </n-tag>
      </div>
    </div>

    <n-card size="small" class="wizard">
      <n-steps :current="step + 1" size="small" class="steps">
        <n-step title="选择模式" description="单端口 / 独立端口" />
        <n-step title="域名与地址" description="https + 备案域名" />
        <n-step title="云服务器" description="frps 与 Token" />
        <n-step title="反向代理" description="nginx 片段" />
        <n-step title="自检并启用" description="逐项验证" />
      </n-steps>

      <!-- 步骤 1：模式 -->
      <div v-if="step === 0" class="step-body">
        <div class="mode-grid">
          <div class="mode-card" :class="{ on: form.frpMode === 'wss' }" @click="pickMode('wss')">
            <div class="mode-head">
              <span class="mode-title">单端口 443</span>
              <n-tag size="tiny" type="success" :bordered="false">推荐 · 小程序可用</n-tag>
            </div>
            <div class="mode-desc">frpc 走 wss，控制通道复用 443，nginx 同时转发网站与隧道</div>
            <ul class="mode-list">
              <li>公网只开 <b>443</b>，安全组最干净</li>
              <li>需要域名 + 证书 + nginx 加一段 <span class="mono">/~!frp</span> 转发</li>
              <li>微信小程序只认 443，这是唯一稳妥的形态</li>
            </ul>
          </div>
          <div class="mode-card" :class="{ on: form.frpMode === 'tcp' }" @click="pickMode('tcp')">
            <div class="mode-head">
              <span class="mode-title">独立端口 TCP</span>
              <n-tag size="tiny" :bordered="false">简单</n-tag>
            </div>
            <div class="mode-desc">经典 frp tcp 映射，云端多开一个端口直连隧道</div>
            <ul class="mode-list">
              <li>配置最少，不依赖 nginx 的 upgrade 转发</li>
              <li>公网会多开一个端口（如 18080）</li>
              <li>小程序仍需 443 反代，所以实际端口更多</li>
            </ul>
          </div>
        </div>
        <n-alert type="info" :bordered="false" style="margin-top: 14px">
          无论哪种模式，打印机的 631 / 9100 都不需要暴露：容器是<b>出站</b>去连内网打印机的。
        </n-alert>
      </div>

      <!-- 步骤 2：域名与地址 -->
      <div v-else-if="step === 1" class="step-body">
        <n-form label-placement="top">
          <div class="grid2">
            <n-form-item label="域名（已备案，指向云服务器）">
              <n-input v-model:value="form.frpDomain" placeholder="print.example.com" @update:value="syncBase">
                <template #prefix><n-icon :component="GlobeOutline" /></template>
              </n-input>
            </n-form-item>
            <n-form-item label="对外访问地址 BASE">
              <n-input v-model:value="form.relayPublicUrl" placeholder="https://print.example.com" @update:value="baseTouched = true">
                <template #suffix>
                  <n-button v-if="baseTouched" text size="tiny" type="primary" @click="resyncBase">重新跟随域名</n-button>
                </template>
              </n-input>
              <template #feedback>
                <span class="muted" style="font-size: 12px">
                  默认由上方域名自动生成（改域名会跟着变）；也可以直接改成你要用的地址，保存后生效。<br>
                  域名填错时改上面的「域名」即可，这里会自动更新；手动改过则点右侧「重新跟随域名」。
                </span>
              </template>
            </n-form-item>
          </div>
          <n-alert type="warning" :bordered="false">
            微信公众平台 → 开发管理 → 服务器域名，需要把这个域名加进
            <b>request 合法域名</b>、<b>uploadFile 合法域名</b>、<b>downloadFile 合法域名</b>；
            少一个，上传文件或预览 PDF 就会直接报错。
          </n-alert>
          <div class="kv" style="margin-top: 12px">
            <span>单文件上限</span><b>{{ st.print?.maxFileMB || 20 }} MB（在「系统设置 → 打印」修改）</b>
          </div>
        </n-form>
      </div>

      <!-- 步骤 3：云服务器 -->
      <div v-else-if="step === 2" class="step-body">
        <n-form label-placement="top">
          <div class="grid2">
            <n-form-item :label="form.frpMode === 'wss' ? '服务端地址（填域名）' : '服务端地址（云服务器 IP / 域名）'">
              <n-input
                v-model:value="form.frpServer"
                :placeholder="form.frpMode === 'wss' ? 'print.example.com' : '1.2.3.4'"
                @update:value="loadPlan"
              />
            </n-form-item>
            <n-form-item :label="form.frpMode === 'wss' ? '服务端端口（复用 443）' : '服务端端口（frps bindPort）'">
              <n-input-number v-model:value="form.frpPort" :min="1" :max="65535" style="width: 100%" @update:value="loadPlan" />
            </n-form-item>
          </div>
          <div class="grid2">
            <n-form-item label="认证 Token（与 frps 一致）">
              <n-input
                v-model:value="form.frpToken" type="password" show-password-on="click"
                :placeholder="st.relay?.frpTokenConfigured ? `已配置 ${st.relay.frpToken}，留空保持不变` : '建议 32 位以上随机串'"
              />
            </n-form-item>
            <n-form-item label="隧道对端端口（remotePort）">
              <n-input-number v-model:value="form.frpRemotePort" :min="1" :max="65535" style="width: 100%" @update:value="loadPlan" />
              <template #feedback>
                <span class="muted" style="font-size: 12px">
                  云端映射出来的端口；nginx 的 <span class="mono">proxy_pass</span> 要指向它
                </span>
              </template>
            </n-form-item>
          </div>
        </n-form>

        <div class="code-head">
          <span class="code-title">① 云服务器上的 frps.toml</span>
          <n-button size="tiny" quaternary @click="copy(plan.frpsToml)">复制</n-button>
        </div>
        <pre class="code">{{ plan.frpsToml }}</pre>
        <div class="muted code-tip">
          启动：<span class="mono">frps -c /etc/frp/frps.toml</span>，systemd 用 <span class="mono">systemctl enable --now frps</span>；
          安全组放行 443，7000 只在云服务器本机需要（不必对公网开放）。
          <template v-if="!plan.tokenConfigured">
            <br />保存后这里会写入实际 Token；先手动把 <span class="mono">auth.token</span> 改成与上方一致的随机串也可以。
          </template>
        </div>
      </div>

      <!-- 步骤 4：nginx -->
      <div v-else-if="step === 3" class="step-body">
        <div class="code-head">
          <span class="code-title">② 云服务器上的 nginx 配置</span>
          <n-button size="tiny" quaternary @click="copy(plan.nginxSnippet)">复制</n-button>
        </div>
        <pre class="code">{{ plan.nginxSnippet }}</pre>
        <div class="muted code-tip">
          证书可用 <span class="mono">certbot --nginx -d {{ form.frpDomain || 'print.example.com' }}</span> 自动申请；
          改完执行 <span class="mono">nginx -t &amp;&amp; nginx -s reload</span>。
        </div>
        <div class="checklist">
          <div class="ck"><n-icon :component="CheckmarkCircle" color="#0ea5a4" />域名 A 记录已指向云服务器</div>
          <div class="ck"><n-icon :component="CheckmarkCircle" color="#0ea5a4" />443 已放行，证书已签发</div>
          <div class="ck">
            <n-icon :component="CheckmarkCircle" color="#0ea5a4" />
            <span v-if="form.frpMode === 'wss'">nginx 增加了 <span class="mono">/~!frp</span> 的 Upgrade 转发</span>
            <span v-else>安全组放行了隧道端口 {{ form.frpRemotePort }}</span>
          </div>
          <div class="ck">
            <n-icon :component="CheckmarkCircle" color="#0ea5a4" />
            PrintGate 容器设置了 <span class="mono">TRUST_PROXY=true</span>（审计才记录真实 IP）
          </div>
          <div v-if="form.frpMode === 'wss'" class="ck">
            <n-icon :component="CheckmarkCircle" color="#0ea5a4" />
            nginx 与 frps 在同一台机器（frps 的 <span class="mono">proxyBindAddr = 127.0.0.1</span> 才能被代理访问）
          </div>
        </div>
      </div>

      <!-- 步骤 5：自检 -->
      <div v-else class="step-body">
        <div class="row" style="justify-content: space-between">
          <span class="muted">自检会在本机实际执行：frpc 语法校验、进程状态、服务端连通、打印机、公网回连</span>
          <n-button size="small" type="primary" ghost :loading="checking" @click="runCheck">运行自检</n-button>
        </div>
        <div v-if="checks.length" class="checks">
          <div v-for="(c, i) in checks" :key="i" class="check-item" :class="{ bad: !c.ok }">
            <n-icon :component="c.ok ? CheckmarkCircle : CloseCircle" :color="c.ok ? '#0ea5a4' : '#e88080'" size="16" />
            <div class="grow" style="min-width: 0">
              <div class="ck-name">{{ c.name }}<span class="ck-detail">{{ c.detail }}</span></div>
              <div v-if="!c.ok && c.hint" class="ck-hint">{{ c.hint }}</div>
            </div>
          </div>
        </div>
        <n-empty v-else description="点「运行自检」逐项检查" style="padding: 24px 0" />

        <n-divider style="margin: 16px 0" />
        <n-checkbox v-model:checked="form.enableFrp">启用 frp 客户端（保存后自动生成 frpc.toml 并重启进程）</n-checkbox>
        <div class="row" style="margin-top: 14px">
          <n-button type="primary" :loading="saving" @click="save">保存并启用</n-button>
          <n-button :loading="restarting" @click="restartFrp">重启 frp 客户端</n-button>
          <n-button quaternary @click="$router.push('/wechat')">去设置小程序参数</n-button>
        </div>
      </div>

      <div class="wizard-foot">
        <n-button v-if="step > 0" size="small" @click="step -= 1">上一步</n-button>
        <div class="grow" />
        <span class="muted foot-hint">{{ stepHint }}</span>
        <n-button v-if="step < 4" size="small" type="primary" @click="next">下一步</n-button>
        <n-button v-else size="small" type="primary" :loading="saving" @click="save">保存并启用</n-button>
      </div>
    </n-card>

    <div class="layout" style="margin-top: 16px">
      <n-card size="small" title="当前链路">
        <div class="kv"><span>模式</span><b>{{ modeText }}</b></div>
        <div class="kv"><span>本机监听</span><b class="mono">0.0.0.0:{{ plan.localPort || 8080 }}</b></div>
        <div class="kv"><span>隧道映射</span><b class="mono">{{ form.frpServer || '—' }}:{{ form.frpPort }} → :{{ form.frpRemotePort }}</b></div>
        <div class="kv"><span>对外地址</span><b class="mono">{{ form.relayPublicUrl || '未设置' }}</b></div>
        <div class="kv"><span>当前访问</span><b class="mono">{{ origin }}</b></div>
        <div class="kv"><span>frpc 配置</span><b class="mono">{{ plan.paths?.frpc || '—' }}</b></div>
      </n-card>

      <n-card size="small" title="API Key">
        <template #header-extra>
          <n-button size="tiny" type="primary" @click="createShow = true">新建密钥</n-button>
        </template>
        <div v-if="keys.length" class="keys">
          <div v-for="k in keys" :key="k.id" class="key" :class="{ revoked: k.revoked }">
            <div class="grow" style="min-width: 0">
              <div class="kname">{{ k.name }} <n-tag v-if="k.revoked" size="tiny" type="default" :bordered="false">已吊销</n-tag></div>
              <div class="muted mono" style="font-size: 11.5px">{{ k.prefix }}</div>
              <div class="muted" style="font-size: 11px">
                创建 {{ fmtTime(k.created_at) }}<span v-if="k.last_used_at"> · 最近使用 {{ fmtTime(k.last_used_at) }}</span>
              </div>
            </div>
            <n-button v-if="!k.revoked" size="tiny" quaternary type="error" @click="revoke(k)">吊销</n-button>
          </div>
        </div>
        <n-empty v-else description="还没有 API Key" style="padding: 24px 0" />
      </n-card>
    </div>

    <n-card size="small" title="第三方对接方式（开放 API）" style="margin-top: 16px">
      <n-tabs type="segment" size="small">
        <n-tab-pane name="upload" tab="上传并打印">
          <pre class="code">{{ apiUpload }}</pre>
        </n-tab-pane>
        <n-tab-pane name="print" tab="按文件 ID 打印">
          <pre class="code">{{ apiPrint }}</pre>
        </n-tab-pane>
        <n-tab-pane name="query" tab="查询任务">
          <pre class="code">{{ apiQuery }}</pre>
        </n-tab-pane>
      </n-tabs>
      <div class="muted" style="margin-top: 10px; font-size: 12.5px; line-height: 1.8">
        鉴权：请求头 <span class="mono">X-API-Key: pg_xxx</span> 或 <span class="mono">Authorization: Bearer pg_xxx</span>；
        也可使用管理员登录后的 JWT。所有调用都会记入审计日志。
      </div>
    </n-card>

    <n-modal v-model:show="createShow" preset="card" title="新建 API Key" style="max-width: 460px" :bordered="false">
      <n-input v-model:value="newName" placeholder="用途备注，例如：ERP 系统" />
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="createShow = false">取消</n-button>
          <n-button type="primary" :loading="creating" @click="createKey">生成</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="tokenShow" preset="card" title="请立即保存密钥" style="max-width: 560px" :bordered="false">
      <n-alert type="warning" :bordered="false" style="margin-bottom: 12px">密钥只显示这一次，关闭后无法再次查看。</n-alert>
      <div class="token-box mono">{{ newToken }}</div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button type="primary" @click="copyToken">复制并关闭</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { CheckmarkCircle, CloseCircle, GlobeOutline } from '@vicons/ionicons5';
import { api, fmtTime } from '../api';

const message = useMessage();
const st = ref({});
const keys = ref([]);
const plan = ref({});
const checks = ref([]);
const step = ref(0);
const saving = ref(false);
// BASE 是否被用户手动改过：改过就不再被域名变化覆盖，避免"刚填好的地址被域名冲掉"
const baseTouched = ref(false);
const checking = ref(false);
const restarting = ref(false);
const createShow = ref(false);
const tokenShow = ref(false);
const creating = ref(false);
const newName = ref('');
const newToken = ref('');
const frpRunning = ref(false);

const form = reactive({
  frpMode: 'wss',
  frpDomain: '',
  frpServer: '',
  frpPort: 443,
  frpToken: '',
  frpRemotePort: 18080,
  relayPublicUrl: '',
  enableFrp: false
});

const origin = computed(() => window.location.origin);
const modeText = computed(() => (form.frpMode === 'wss' ? '单端口 443（wss 复用）' : '独立端口 TCP'));
const stepHint = computed(() => ([
  '选好后点下一步',
  '域名要已备案，BASE 必须是 https',
  'Token 与云上 frps 保持一致',
  '把片段贴到云服务器 nginx',
  '自检全绿再启用'
][step.value]));

function pickMode(m) {
  form.frpMode = m;
  if (m === 'wss') {
    form.frpPort = 443;
    if (!form.frpDomain && /^[a-z0-9.-]+$/i.test(form.frpServer || '')) form.frpDomain = form.frpServer;
  } else if (form.frpPort === 443) {
    form.frpPort = 7000;
  }
  loadPlan();
}

function syncBase(v) {
  // 域名变了就跟着变，但用户手动改过 BASE 后不强行覆盖（点「重新跟随域名」可恢复）
  if (!baseTouched.value) {
    form.relayPublicUrl = v ? `https://${v}` : '';
  }
  loadPlan();
}

// 手动改过 BASE 后，想重新按域名推导时调它
function resyncBase() {
  baseTouched.value = false;
  form.relayPublicUrl = form.frpDomain ? `https://${form.frpDomain}` : '';
  loadPlan();
}

async function load() {
  try {
    const [s, k, svc] = await Promise.all([api.get('/settings'), api.get('/keys'), api.get('/system/services')]);
    st.value = s.settings || {};
    keys.value = k.keys || [];
    Object.assign(form, {
      frpMode: st.value.relay?.frpMode || 'wss',
      frpDomain: st.value.relay?.frpDomain || '',
      frpServer: st.value.relay?.frpServer || '',
      frpPort: st.value.relay?.frpPort ?? (st.value.relay?.frpMode === 'wss' ? 443 : 7000),
      frpToken: '',
      frpRemotePort: st.value.relay?.frpRemotePort || 18080,
      relayPublicUrl: st.value.relay?.relayPublicUrl || '',
      enableFrp: !!st.value.relay?.enableFrp
    });
    // 每次进页面都回到"跟随域名"状态：已保存的 BASE 是上次的结果，不是用户当场手改的
    baseTouched.value = false;
    // 首次配置（还没有服务端地址）时默认给推荐的单端口方案
    if (!st.value.relay?.frpServer) {
      form.frpMode = 'wss';
      form.frpPort = 443;
      form.frpRemotePort = 18080;
    }
    frpRunning.value = (svc.services || []).some((x) => x.key === 'frp' && x.running);
    await loadPlan();
  } catch (e) {
    message.error(e.message);
  }
}

async function loadPlan() {
  try {
    const q = new URLSearchParams({
      mode: form.frpMode,
      domain: form.frpDomain || '',
      server: form.frpServer || '',
      serverPort: String(form.frpPort || ''),
      remotePort: String(form.frpRemotePort || ''),
      base: form.relayPublicUrl || ''
    });
    plan.value = await api.get(`/relay/plan?${q.toString()}`);
  } catch (e) {
    message.error(e.message);
  }
}

function next() {
  if (step.value === 1) {
    if (!form.frpDomain) { message.warning('请填写域名'); return; }
    if (!/^https:\/\//i.test(form.relayPublicUrl || '')) { message.warning('BASE 必须是 https:// 开头'); return; }
  }
  if (step.value === 2) {
    if (!form.frpServer) { message.warning('请填写服务端地址'); return; }
    if (!form.frpToken && !st.value.relay?.frpTokenConfigured) { message.warning('请填写 Token'); return; }
  }
  step.value = Math.min(4, step.value + 1);
  if (step.value === 4) runCheck();
}

async function save() {
  saving.value = true;
  try {
    const payload = {
      frpMode: form.frpMode,
      frpDomain: form.frpDomain,
      frpServer: form.frpServer,
      frpPort: Number(form.frpPort),
      frpRemotePort: Number(form.frpRemotePort),
      relayPublicUrl: form.relayPublicUrl,
      enableFrp: form.enableFrp
    };
    if (form.frpToken) payload.frpToken = form.frpToken;
    const d = await api.put('/settings', payload);
    st.value = d.settings;
    message.success('已保存，frpc 配置已重新生成');
    await loadPlan();
    setTimeout(() => { load(); runCheck(); }, 2000);
  } catch (e) {
    message.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function runCheck() {
  checking.value = true;
  try {
    const d = await api.post('/relay/check', {
      mode: form.frpMode,
      domain: form.frpDomain,
      server: form.frpServer,
      serverPort: form.frpPort,
      remotePort: form.frpRemotePort,
      base: form.relayPublicUrl
    });
    checks.value = d.checks || [];
    if (d.passed === d.total) message.success(`自检通过 ${d.passed}/${d.total}`);
  } catch (e) {
    message.error(e.message);
  } finally {
    checking.value = false;
  }
}

async function restartFrp() {
  restarting.value = true;
  try {
    const d = await api.post('/relay/restart', {});
    message[d.ok ? 'success' : 'error'](d.msg || '已执行');
    setTimeout(() => { load(); }, 1500);
  } catch (e) {
    message.error(e.message);
  } finally {
    restarting.value = false;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    message.success('已复制');
  } catch (_) {
    message.warning('浏览器不允许自动复制，请手动选择文本');
  }
}

async function createKey() {
  creating.value = true;
  try {
    const d = await api.post('/keys', { name: newName.value || '未命名密钥' });
    newToken.value = d.token;
    createShow.value = false;
    tokenShow.value = true;
    newName.value = '';
    load();
  } catch (e) { message.error(e.message); } finally { creating.value = false; }
}

async function revoke(k) {
  try {
    const d = await api.delete(`/keys/${k.id}`);
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
}

async function copyToken() {
  try { await navigator.clipboard.writeText(newToken.value); message.success('已复制'); } catch (_) {}
  tokenShow.value = false;
}

const apiUpload = `# 一步完成：上传文件并打印
curl -X POST ${'${BASE}'}/api/print/upload \\
  -H "X-API-Key: pg_xxxxxxxx" \\
  -F "file=@./test.pdf" \\
  -F "printer=Office-MF650C" \\
  -F 'options={"copies":2,"color":"mono","sides":"two-sided-long-edge","media":"A4"}'

# 返回
{ "ok": true, "taskId": 12, "status": "approved", "msg": "已发送到打印机" }`;

const apiPrint = `# 1) 先上传
curl -X POST ${'${BASE}'}/api/files -H "X-API-Key: pg_xxxxxxxx" -F "file=@./test.pdf"
# -> { "ok": true, "file": { "id": 5, ... } }

# 2) 再提交打印
curl -X POST ${'${BASE}'}/api/print \\
  -H "X-API-Key: pg_xxxxxxxx" -H "Content-Type: application/json" \\
  -d '{"fileId":5,"printer":"Office-MF650C","options":{"copies":1,"color":"color"}}'`;

const apiQuery = `curl "${'${BASE}'}/api/tasks?status=all&size=10" -H "X-API-Key: pg_xxxxxxxx"
curl "${'${BASE}'}/api/health"`;

onMounted(load);
</script>

<style scoped>
.wizard { margin-bottom: 4px; }
.steps { margin-bottom: 18px; }
.step-body { min-height: 210px; }
.step-body :deep(.n-form-item:last-child) { margin-bottom: 0; }
.mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.mode-card {
  border: 1px solid var(--pg-border); border-radius: 12px; padding: 14px; cursor: pointer;
  transition: border-color .15s, background .15s;
}
.mode-card:hover { border-color: rgba(14, 165, 164, .5); }
.mode-card.on { border-color: #0ea5a4; background: rgba(14, 165, 164, .06); }
.mode-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.mode-title { font-size: 14px; font-weight: 500; }
.mode-desc { font-size: 12.5px; opacity: .75; line-height: 1.7; }
.mode-list { margin: 10px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.9; opacity: .85; }
.mode-list li { list-style: disc; }
.code-head { display: flex; align-items: center; justify-content: space-between; margin: 6px 0 8px; }
.code-title { font-size: 13px; font-weight: 500; }
.code {
  background: #0f172a; color: #cbd5e1; padding: 14px; border-radius: 10px;
  font-size: 12px; line-height: 1.7; overflow-x: auto; margin: 0;
}
.code-tip { margin-top: 8px; font-size: 12px; line-height: 1.8; }
.checklist { display: grid; gap: 8px; margin-top: 14px; }
.ck { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.checks { display: grid; gap: 6px; margin-top: 12px; max-height: 320px; overflow-y: auto; }
.check-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 8px; background: rgba(14, 165, 164, .05); }
.check-item.bad { background: rgba(232, 128, 128, .08); }
.ck-name { font-size: 13px; }
.ck-detail { margin-left: 8px; font-size: 12px; opacity: .7; }
.ck-hint { margin-top: 4px; font-size: 12px; color: #b45309; line-height: 1.6; }
.wizard-foot { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--pg-border); }
.foot-hint { font-size: 12px; }
.layout { display: grid; grid-template-columns: 1.05fr .95fr; gap: 16px; align-items: start; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px dashed #eef2f6; font-size: 13px; }
.kv:last-child { border-bottom: none; }
.keys { display: grid; gap: 8px; max-height: 300px; overflow-y: auto; }
.key { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid var(--pg-border); border-radius: 10px; }
.key.revoked { opacity: .55; }
.kname { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
.token-box { background: #f1f5f9; color: #0f172a; padding: 12px; border-radius: 10px; word-break: break-all; }
@media (max-width: 900px) {
  .mode-grid, .layout, .grid2 { grid-template-columns: 1fr; }
  .steps { display: none; }
}
</style>
