<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">小程序用户</h1>
        <div class="page-desc">微信登录用户默认需审批授权后才能打印，可查看头像/微信号等申请资料，随时拉黑或提权</div>
      </div>
      <div class="row wrap">
        <n-input v-model:value="q" size="small" clearable placeholder="昵称 / 微信号 / 手机号 / OpenID" style="width: 240px" @keyup.enter="reload" />
        <n-button size="small" :loading="loading" @click="reload">
          <template #icon><n-icon :component="RefreshOutline" /></template>刷新
        </n-button>
        <n-button size="small" @click="exportCsv">
          <template #icon><n-icon :component="DownloadOutline" /></template>导出
        </n-button>
      </div>
    </div>

    <div class="statline">
      <div class="s"><b>{{ stats.total }}</b><span>全部用户</span></div>
      <div class="s warn"><b>{{ stats.pending }}</b><span>待审批</span></div>
      <div class="s ok"><b>{{ stats.approved }}</b><span>已授权</span></div>
      <div class="s"><b>{{ stats.admins }}</b><span>管理员</span></div>
      <div class="s bad"><b>{{ stats.rejected }}</b><span>已拒绝</span></div>
      <div class="s"><b>{{ stats.blocked }}</b><span>已拉黑</span></div>
    </div>

    <n-card size="small">
      <div class="filter-bar">
        <n-radio-group v-model:value="status" size="small" @update:value="reload">
          <n-radio-button value="pending">待审批{{ stats.pending ? ` (${stats.pending})` : '' }}</n-radio-button>
          <n-radio-button value="approved">已授权</n-radio-button>
          <n-radio-button value="rejected">已拒绝</n-radio-button>
          <n-radio-button value="blocked">已拉黑</n-radio-button>
          <n-radio-button value="all">全部</n-radio-button>
        </n-radio-group>
        <div class="row" style="margin-left: auto">
          <n-button size="tiny" type="primary" @click="openCreate">＋ 添加用户</n-button>
          <n-button v-if="checked.length" size="tiny" type="success" secondary @click="batch('approve')">批量通过 ({{ checked.length }})</n-button>
          <n-button v-if="checked.length" size="tiny" type="error" secondary @click="batch('reject')">批量拒绝</n-button>
          <n-button v-if="checked.length" size="tiny" quaternary @click="checked = []">取消选择</n-button>
        </div>
      </div>

      <n-spin :show="loading">
        <n-table v-if="users.length" :single-line="false" size="small">
          <thead>
            <tr>
              <th style="width: 38px">
                <n-checkbox
                  :checked="allChecked" :indeterminate="partialChecked"
                  @update:checked="toggleAll"
                />
              </th>
              <th class="col-id" style="width: 56px">ID</th>
              <th style="width: 200px">用户</th>
              <th style="width: 150px">微信号 / 手机号</th>
              <th class="col-openid">OpenID</th>
              <th style="width: 90px">角色</th>
              <th style="width: 90px">状态</th>
              <th style="width: 130px">申请时间</th>
              <th style="width: 210px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" class="urow">
              <td><n-checkbox :checked="checked.includes(u.id)" @update:checked="(v) => toggleOne(v, u.id)" /></td>
              <td class="mono col-id">{{ u.id }}</td>
              <td>
                <div class="row" style="gap: 8px; cursor: pointer" @click="openDetail(u)">
                  <div class="av">
                    <img v-if="u.avatar" :src="avatarUrl(u.avatar)" alt="" @error="u._bad = true" />
                    <span v-else>{{ (u.nickname || '微')[0] }}</span>
                  </div>
                  <div style="min-width: 0">
                    <div class="uname">{{ u.nickname || (u.username || '微信用户') }}</div>
                    <div class="muted" style="font-size: 11.5px">
                      <n-tag v-if="u.username" size="tiny" :bordered="false" type="info">账号 {{ u.username }}</n-tag>
                      <n-tag v-else size="tiny" :bordered="false">微信</n-tag>
                      <span style="margin-left: 6px">{{ u.real_name || '未填姓名' }}</span><span v-if="u.note"> · {{ u.note }}</span>
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <div class="cell-line" :title="u.wechat_id"><span class="k">微信</span>{{ u.wechat_id || '—' }}</div>
                <div class="cell-line muted" :title="u.phone"><span class="k">手机</span>{{ u.phone || '—' }}</div>
              </td>
              <td class="mono oid col-openid" :title="u.openid" @click="copy(u.openid)">{{ u.openid }}</td>
              <td>
                <n-tag size="tiny" :type="u.role === 'admin' ? 'primary' : 'default'" :bordered="false">
                  {{ u.role === 'admin' ? '管理员' : '用户' }}
                </n-tag>
              </td>
              <td>
                <n-tag size="small" :type="statusMeta(u.status).type" :bordered="false">{{ statusMeta(u.status).text }}</n-tag>
              </td>
              <td class="muted">{{ fmtTime(u.created_at) }}</td>
              <td>
                <n-button v-if="u.status !== 'approved'" size="tiny" type="primary" secondary @click="act(u, 'approve')">授权</n-button>
                <n-button v-if="u.status === 'pending'" size="tiny" quaternary type="error" @click="act(u, 'reject')">拒绝</n-button>
                <n-button v-if="u.status === 'approved'" size="tiny" quaternary @click="act(u, 'block')">拉黑</n-button>
                <n-button v-if="u.status === 'blocked'" size="tiny" quaternary type="primary" @click="act(u, 'unblock')">解除</n-button>
                <n-button size="tiny" quaternary @click="openDetail(u)">
                  <template #icon><n-icon :component="EyeOutline" /></template>
                </n-button>
                <n-dropdown :options="moreOptions(u)" trigger="click" @select="(k) => onMore(k, u)">
                  <n-button size="tiny" quaternary>
                    <template #icon><n-icon :component="EllipsisHorizontalOutline" /></template>
                  </n-button>
                </n-dropdown>
              </td>
            </tr>
          </tbody>
        </n-table>
        <n-empty v-else description="暂无用户" style="padding: 50px 0" />
      </n-spin>

      <template #footer>
        <div class="row-between">
          <span class="muted">共 {{ total }} 位用户</span>
          <n-pagination v-model:page="page" :page-size="size" :item-count="total" size="small" @update:page="load" />
        </div>
      </template>
    </n-card>

    <!-- 添加用户：普通用户账号来自微信，必须登记 OpenID -->
    <n-modal v-model:show="bindShow" preset="card" :title="`扫码绑定微信 · ${bindUser.nickname || bindUser.username || ''}`" style="max-width: 420px">
      <div class="bind-wrap">
        <n-spin :show="bindLoading">
          <img v-if="bindQr" class="bind-qr" :src="bindQr" alt="绑定二维码" />
          <div v-else class="bind-empty">正在生成二维码…</div>
        </n-spin>
        <div class="bind-tip">
          请本人用小程序「我的 → 扫码绑定」扫描此码
        </div>
        <div class="bind-meta">
          <span v-if="bindLeft > 0">{{ bindLeft }} 秒后过期</span>
          <span v-else class="expired">已过期，请重新生成</span>
          <n-button size="tiny" quaternary type="primary" @click="genBindQr">重新生成</n-button>
        </div>
        <n-alert v-if="bindDone" type="success" :bordered="false" style="margin-top: 10px">
          已绑定：{{ bindDone.name }}
        </n-alert>
      </div>
    </n-modal>


    <n-modal v-model:show="createShow" preset="card" title="添加小程序用户" style="max-width: 560px">
      <n-radio-group v-model:value="createForm.mode" style="margin-bottom: 14px" @update:value="onModeChange">
        <n-radio-button value="wechat">微信用户（OpenID）</n-radio-button>
        <n-radio-button value="account">账号密码</n-radio-button>
      </n-radio-group>

      <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
        <template v-if="createForm.mode === 'account'">
          直接给对方一个用户名和密码，本人用登录页「普通用户 → 登录」即可进入打印门户，无需微信。
        </template>
        <template v-else>
          OpenID 是微信身份，唯一且不能乱编。让对方在小程序「我的 → 我的资料」页点「复制 OpenID」发给你，
          填进来并设为「已授权」后，TA 用微信登录即可直接使用（系统会认这个账号，不会重复建号）。
        </template>
      </n-alert>
      <n-form label-placement="top">
        <template v-if="createForm.mode === 'account'">
          <div class="grid2">
            <n-form-item label="用户名（必填）">
              <n-input v-model:value="createForm.username" placeholder="3-32 位小写字母/数字" />
            </n-form-item>
            <n-form-item label="初始密码（必填）">
              <n-input v-model:value="createForm.password" type="password" show-password-on="click" placeholder="≥8 位，含字母和数字" />
            </n-form-item>
          </div>
        </template>
        <n-form-item v-else label="OpenID（必填）">
          <n-input v-model:value="createForm.openid" placeholder="例如 oX7bJ5AbCdEfGhIjKlMnOpQrStUv" />
        </n-form-item>
        <div class="grid2">
          <n-form-item label="昵称"><n-input v-model:value="createForm.nickname" placeholder="如「财务-李敏」" /></n-form-item>
          <n-form-item label="姓名"><n-input v-model:value="createForm.real_name" placeholder="选填" /></n-form-item>
          <n-form-item label="微信号"><n-input v-model:value="createForm.wechat_id" placeholder="选填" /></n-form-item>
          <n-form-item label="手机号"><n-input v-model:value="createForm.phone" placeholder="选填" /></n-form-item>
          <n-form-item label="角色"><n-select v-model:value="createForm.role" :options="roleOptions" /></n-form-item>
          <n-form-item label="状态"><n-select v-model:value="createForm.status" :options="statusOptions" /></n-form-item>
        </div>
        <n-form-item label="管理员备注">
          <n-input v-model:value="createForm.note" placeholder="选填，例如「三楼财务」" />
        </n-form-item>
      </n-form>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button quaternary @click="createShow = false">取消</n-button>
          <n-button type="primary" :loading="creating" @click="submitCreate">添加</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 用户详情：管理员看的申请资料都在这里 -->
    <n-drawer v-model:show="detailShow" :width="460" placement="right">
      <n-drawer-content :title="detail.user ? (detail.user.nickname || '微信用户') : '用户'" closable>
        <div v-if="detail.user">
          <div class="d-head">
            <div class="av big">
              <img v-if="detail.user.avatar" :src="avatarUrl(detail.user.avatar)" alt="" />
              <span v-else>{{ (detail.user.nickname || '微')[0] }}</span>
            </div>
            <div style="min-width: 0">
              <div class="d-name">{{ detail.user.nickname || '微信用户' }}</div>
              <div class="row" style="gap: 6px; margin-top: 4px">
                <n-tag size="tiny" :type="statusMeta(detail.user.status).type" :bordered="false">{{ statusMeta(detail.user.status).text }}</n-tag>
                <n-tag v-if="detail.user.role === 'admin'" size="tiny" type="primary" :bordered="false">管理员</n-tag>
              </div>
              <div class="muted d-openid" @click="copy(detail.user.openid)">{{ detail.user.openid }}</div>
            </div>
          </div>

          <n-divider style="margin: 14px 0" />

          <div class="d-grid">
            <div class="d-item"><label>微信号</label><span>{{ detail.user.wechat_id || '未填写' }}</span></div>
            <div class="d-item"><label>手机号</label><span>{{ detail.user.phone || '未填写' }}</span></div>
            <div class="d-item"><label>姓名</label><span>{{ detail.user.real_name || '未填写' }}</span></div>
            <div class="d-item"><label>申请时间</label><span>{{ fmtTime(detail.user.created_at) }}</span></div>
            <div class="d-item"><label>授权时间</label><span>{{ fmtTime(detail.user.approved_at) }}</span></div>
            <div class="d-item"><label>最近登录</label><span>{{ fmtTime(detail.user.last_login) }}</span></div>
          </div>

          <div class="d-block">
            <label>申请说明</label>
            <div class="d-note">{{ detail.user.apply_note || '用户未填写' }}</div>
          </div>

          <div class="d-stats" v-if="detail.stats">
            <div><b>{{ detail.stats.tasks }}</b><span>打印任务</span></div>
            <div><b>{{ detail.stats.copies }}</b><span>累计份数</span></div>
            <div><b>{{ detail.stats.files }}</b><span>上传文件</span></div>
          </div>

          <div class="d-block" v-if="(detail.recent || []).length">
            <label>最近任务</label>
            <div v-for="t in detail.recent" :key="t.id" class="d-task">
              <span class="tname" :title="t.filename || '(文件已清理)'">{{ t.filename || '(文件已清理)' }}</span>
              <span class="muted">×{{ t.copies }}</span>
              <n-tag size="tiny" :type="(STATUS_META[t.status] || {}).type || 'default'" :bordered="false">
                {{ (STATUS_META[t.status] || {}).text || t.status }}
              </n-tag>
              <span class="muted">{{ fmtTime(t.created_at) }}</span>
            </div>
          </div>

          <div class="d-block">
            <label>管理员备注</label>
            <n-input v-model:value="detailNote" type="textarea" :rows="2" placeholder="例如：三楼财务 张工" />
            <n-button size="tiny" type="primary" style="margin-top: 8px" :loading="savingNote" @click="saveDetailNote">保存备注</n-button>
          </div>

          <div class="d-actions">
            <n-button v-if="detail.user.status !== 'approved'" size="small" type="primary" @click="act(detail.user, 'approve', true)">授权</n-button>
            <n-button v-if="detail.user.status === 'pending'" size="small" quaternary type="error" @click="act(detail.user, 'reject', true)">拒绝</n-button>
            <n-button v-if="detail.user.status === 'approved'" size="small" quaternary @click="act(detail.user, 'block', true)">拉黑</n-button>
            <n-button v-if="detail.user.status === 'blocked'" size="small" quaternary type="primary" @click="act(detail.user, 'unblock', true)">解除</n-button>
            <n-button size="small" quaternary @click="act(detail.user, detail.user.role === 'admin' ? 'demote' : 'promote', true)">
              {{ detail.user.role === 'admin' ? '取消管理员' : '设为管理员' }}
            </n-button>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import { useRoute } from 'vue-router';
import { RefreshOutline, EllipsisHorizontalOutline, EyeOutline, DownloadOutline } from '@vicons/ionicons5';
import { api, fmtTime, USER_STATUS, STATUS_META } from '../api';

const message = useMessage();
const dialog = useDialog();
const route = useRoute();
const loading = ref(false);
const users = ref([]);
const status = ref('pending');
const q = ref('');
const page = ref(1);
const size = ref(20);
const total = ref(0);
const stats = ref({ total: 0, pending: 0, approved: 0, rejected: 0, blocked: 0, admins: 0 });

const checked = ref([]);
const detailShow = ref(false);
const detail = ref({ user: null, stats: null, recent: [] });
const detailNote = ref('');
const savingNote = ref(false);

// ---------- 扫码绑定 ----------
const bindShow = ref(false);
const bindUser = ref({});
const bindQr = ref('');
const bindLoading = ref(false);
const bindLeft = ref(0);
const bindDone = ref(null);
let bindTimer = null;
let bindPoll = null;

function clearBindTimers() {
  if (bindTimer) { clearInterval(bindTimer); bindTimer = null; }
  if (bindPoll) { clearInterval(bindPoll); bindPoll = null; }
}

// 重置普通用户密码：不传密码就由后端生成随机强密码，只回显一次
async function resetPassword(u) {
  dialog.warning({
    title: '重置密码',
    content: `将把「${u.nickname || u.username || u.openid}」的密码重置为随机强密码，该用户所有已登录会话会立即失效。`,
    positiveText: '确认重置',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.post(`/users/${u.id}/reset-password`);
        dialog.success({
          title: '已重置',
          content: `新密码：${d.password}
请立即告知本人，此密码只显示这一次。`,
          positiveText: '复制并关闭',
          onPositiveClick: () => {
            if (navigator.clipboard) {
              navigator.clipboard.writeText(d.password).then(
                () => message.success('已复制'),
                () => message.warning('复制失败，请手动记录')
              );
            }
          }
        });
      } catch (e) {
        message.error(e.message || '重置失败');
      }
    }
  });
}

async function openBind(u) {
  bindUser.value = u;
  bindDone.value = null;
  bindShow.value = true;
  await genBindQr();
}

async function genBindQr() {
  if (!bindUser.value || !bindUser.value.id) return;
  clearBindTimers();
  bindDone.value = null;
  bindLoading.value = true;
  bindQr.value = '';
  try {
    const d = await api.post(`/users/${bindUser.value.id}/bind-qr`);
    bindQr.value = d.qr;
    bindLeft.value = d.expiresIn || 120;
    bindTimer = setInterval(() => {
      bindLeft.value -= 1;
      if (bindLeft.value <= 0) { clearInterval(bindTimer); bindTimer = null; }
    }, 1000);
    // 每 2 秒看一次有没有被扫掉；绑上就停
    bindPoll = setInterval(async () => {
      try {
        const st = await api.get(`/users/${bindUser.value.id}/bind-status`);
        if (st.bound) {
          clearBindTimers();
          bindDone.value = { name: st.nickname || ('openid…' + st.openidTail) };
          load();
        }
      } catch (_) { /* 忽略抖动 */ }
    }, 2000);
  } catch (e) {
    message.error(e.message);
  } finally {
    bindLoading.value = false;
  }
}

onBeforeUnmount(clearBindTimers);

const statusMeta = (s) => USER_STATUS[s] || { text: s, type: 'default' };
const avatarUrl = (v) => (/^https?:\/\//.test(v || '') ? v : v || '');

const allChecked = computed(() => users.value.length > 0 && checked.value.length === users.value.length);
const partialChecked = computed(() => checked.value.length > 0 && !allChecked.value);

function toggleAll(v) {
  checked.value = v ? users.value.map((u) => u.id) : [];
}
function toggleOne(v, id) {
  checked.value = v ? [...new Set([...checked.value, id])] : checked.value.filter((x) => x !== id);
}

async function load() {
  loading.value = true;
  try {
    const d = await api.get(`/users?status=${status.value}&page=${page.value}&size=${size.value}&q=${encodeURIComponent(q.value)}`);
    users.value = (d.users || []).map((u) => ({ ...u, _bad: false }));
    total.value = d.total || 0;
    stats.value = Object.assign({ total: 0, pending: 0, approved: 0, rejected: 0, blocked: 0, admins: 0 }, d.stats || {});
    checked.value = checked.value.filter((id) => users.value.some((u) => u.id === id));
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}

const reload = () => { page.value = 1; load(); };

// 导出当前筛选下的用户台账（含微信号等申请资料，Excel 打开不乱码）
async function exportCsv() {
  try {
    const blob = await api.get(`/users/export?status=${status.value}`, { responseType: 'blob' });
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
    const a = document.createElement('a');
    a.href = url;
    a.download = `printgate-users-${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    message.success('已导出');
  } catch (e) { message.error(e.message); }
}

async function act(u, action, inDrawer = false) {
  try {
    const d = await api.post(`/users/${u.id}/${action}`);
    message.success(d.msg);
    if (inDrawer && d.user) detail.value.user = d.user;
    load();
  } catch (e) { message.error(e.message); }
}

async function batch(action) {
  const label = { approve: '通过', reject: '拒绝', block: '拉黑', unblock: '解除拉黑' }[action];
  dialog.warning({
    title: `批量${label}`,
    content: `将对选中的 ${checked.value.length} 位用户执行「${label}」，确认继续？`,
    positiveText: label,
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.post('/users/batch', { ids: checked.value, action });
        message.success(d.msg);
        checked.value = [];
        load();
      } catch (e) { message.error(e.message); }
    }
  });
}

async function openDetail(u) {
  detailShow.value = true;
  detail.value = { user: u, stats: null, recent: [] };
  detailNote.value = u.note || '';
  try {
    const d = await api.get(`/users/${u.id}`);
    detail.value = { user: d.user || u, stats: d.stats || null, recent: d.recent || [] };
    detailNote.value = (d.user || u).note || '';
  } catch (e) { message.error(e.message); }
}

const createShow = ref(false);
const creating = ref(false);
const createForm = reactive({
  mode: 'wechat', openid: '', username: '', password: '',
  nickname: '', real_name: '', wechat_id: '', phone: '', role: 'user', status: 'approved', note: ''
});
const roleOptions = [{ label: '普通用户', value: 'user' }, { label: '管理员', value: 'admin' }];
const statusOptions = [
  { label: '已授权（可直接使用）', value: 'approved' },
  { label: '待审批', value: 'pending' },
  { label: '已拉黑', value: 'blocked' }
];

function openCreate() {
  Object.assign(createForm, {
    mode: 'wechat', openid: '', username: '', password: '',
    nickname: '', real_name: '', wechat_id: '', phone: '', role: 'user', status: 'approved', note: ''
  });
  createShow.value = true;
}

function onModeChange() { createForm.openid = ''; createForm.username = ''; createForm.password = ''; }

async function submitCreate() {
  const isAcc = createForm.mode === 'account';
  if (isAcc) {
    if (!String(createForm.username || '').trim()) return message.warning('用户名必填');
    if (!createForm.password) return message.warning('初始密码必填');
  } else if (!String(createForm.openid || '').trim()) {
    return message.warning('OpenID 必填');
  }
  creating.value = true;
  try {
    const payload = { ...createForm };
    if (!isAcc) delete payload.username, delete payload.password;
    const d = await api.post('/users', payload);
    message.success(d.msg || '已添加');
    createShow.value = false;
    if (status.value !== 'all' && status.value !== createForm.status) status.value = 'all';
    await load();
  } catch (e) {
    message.error(e.message);
  } finally {
    creating.value = false;
  }
}

async function saveDetailNote() {
  if (!detail.value.user) return;
  savingNote.value = true;
  try {
    const d = await api.put(`/users/${detail.value.user.id}`, { note: detailNote.value });
    message.success(d.msg);
    if (d.user) detail.value.user = d.user;
    load();
  } catch (e) { message.error(e.message); }
  finally { savingNote.value = false; }
}

function moreOptions(u) {
  return [
    { label: u.role === 'admin' ? '取消管理员' : '设为管理员', key: u.role === 'admin' ? 'demote' : 'promote' },
    { label: '查看申请资料', key: 'detail' },
    { label: u.openid && !/^local_/.test(u.openid) ? '重新绑定微信' : '扫码绑定微信', key: 'bind' },
    { label: '重置密码', key: 'reset' },
    { type: 'divider', key: 'd' },
    { label: '删除用户及数据', key: 'delete' }
  ];
}

function onMore(key, u) {
  if (key === 'detail') return openDetail(u);
  if (key === 'bind') return openBind(u);
  if (key === 'reset') return resetPassword(u);
  if (key === 'bind') return openBind(u);
  if (key === 'delete') {
    dialog.error({
      title: '删除用户',
      content: `将删除「${u.nickname || u.openid}」及其上传文件和打印记录，不可恢复。`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: async () => {
        try {
          const d = await api.delete(`/users/${u.id}`);
          message.success(d.msg);
          if (detailShow.value && detail.value.user && detail.value.user.id === u.id) detailShow.value = false;
          load();
        } catch (e) { message.error(e.message); }
      }
    });
    return;
  }
  act(u, key);
}

function copy(text) {
  if (!text) return;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); message.success('OpenID 已复制'); } catch (_) { message.info(text); }
  document.body.removeChild(ta);
}

const onRefresh = () => load();
onMounted(async () => {
  // 支持 /users?status=approved 这类直达链接（首页「待审批」「去审批」都带这个参数）
  const st = String(route.query.status || '');
  if (['pending', 'approved', 'rejected', 'blocked', 'all'].includes(st)) status.value = st;
  load();
  // 从任务页「查看用户资料」跳过来时，直接打开对应用户的抽屉
  const uid = parseInt(route.query.uid, 10);
  if (Number.isFinite(uid)) {
    try {
      const d = await api.get(`/users/${uid}`);
      if (d.user) {
        detail.value = { user: d.user, stats: d.stats || null, recent: d.recent || [] };
        detailNote.value = d.user.note || '';
        detailShow.value = true;
      }
    } catch (_) { /* 用户可能已被删除，忽略 */ }
  }
  window.addEventListener('pg:refresh', onRefresh);
});
onBeforeUnmount(() => window.removeEventListener('pg:refresh', onRefresh));
</script>

<style scoped>
.bind-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.bind-qr { width: 240px; height: 240px; border-radius: 12px; border: 1px solid var(--pg-border); background: #fff; padding: 8px; }
.bind-empty { width: 240px; height: 240px; display: grid; place-items: center; color: var(--pg-muted); font-size: 13px; }
.bind-tip { font-size: 13px; color: var(--pg-muted); text-align: center; }
.bind-meta { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--pg-muted); }
.bind-meta .expired { color: #ef4444; }
.filter-bar { margin-bottom: 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.statline { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 16px; }
.s { background: #fff; border: 1px solid var(--pg-border); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
.s b { font-size: 20px; }
.s span { font-size: 12px; color: var(--pg-muted); }
.s.warn b { color: #d97706; }
.s.ok b { color: #16a34a; }
.s.bad b { color: #dc2626; }
.av { width: 30px; height: 30px; border-radius: 50%; background: linear-gradient(140deg, #0ea5a4, #0284c7); color: #fff; display: grid; place-items: center; font-size: 12px; flex: 0 0 30px; overflow: hidden; }
.av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.av.big { width: 64px; height: 64px; flex-basis: 64px; font-size: 22px; }
.uname { font-size: 13px; font-weight: 550; }
.cell-line { font-size: 12px; display: flex; gap: 6px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-line .k { color: var(--pg-muted); font-size: 11px; flex: 0 0 auto; }
.oid { font-size: 11.5px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.urow:hover { background: #f8fafc; }

.d-head { display: flex; gap: 14px; align-items: center; }
.d-name { font-size: 16px; font-weight: 650; }
.d-openid { font-size: 11.5px; margin-top: 4px; cursor: pointer; word-break: break-all; }
.d-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.d-item label { display: block; font-size: 11.5px; color: var(--pg-muted); margin-bottom: 2px; }
.d-item span { font-size: 13px; }
.d-block { margin-top: 14px; }
.d-block label { display: block; font-size: 11.5px; color: var(--pg-muted); margin-bottom: 4px; }
.d-note { background: #f8fafc; border: 1px solid var(--pg-border); border-radius: 8px; padding: 8px 10px; font-size: 13px; min-height: 38px; }
.d-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px; }
.d-stats div { background: #f8fafc; border: 1px solid var(--pg-border); border-radius: 10px; padding: 10px; text-align: center; }
.d-stats b { display: block; font-size: 17px; }
.d-stats span { font-size: 11.5px; color: var(--pg-muted); }
.d-task { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 5px 0; border-bottom: 1px dashed var(--pg-border); }
.d-task .tname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 18px; }
@media (max-width: 800px) {
  .statline { grid-template-columns: repeat(2, 1fr); }
  .d-grid { grid-template-columns: 1fr; }
  /* 手机上表太挤：OpenID / ID 可从详情抽屉里看 */
  .col-openid, .col-id { display: none; }
  .uname { white-space: nowrap; }
}
</style>
