<template>
  <n-config-provider :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-loading-bar-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <n-message-provider>
            <router-view />
          </n-message-provider>
        </n-notification-provider>
      </n-dialog-provider>
    </n-loading-bar-provider>
  </n-config-provider>
</template>

<script setup>
import { zhCN, dateZhCN } from 'naive-ui';

const themeOverrides = {
  common: {
    primaryColor: '#0ea5a4',
    primaryColorHover: '#14b8a6',
    primaryColorPressed: '#0d9488',
    primaryColorSuppl: '#14b8a6',
    infoColor: '#3b82f6',
    successColor: '#16a34a',
    warningColor: '#f59e0b',
    errorColor: '#ef4444',
    borderRadius: '10px',
    borderRadiusSmall: '8px',
    fontSize: '14px',
    textColorBase: '#1f2937',
    bodyColor: '#f5f7fa'
  },
  Card: { borderRadius: '14px', color: '#ffffff', borderColor: '#eceff3' },
  Button: { fontWeight: '500' },
  Menu: { itemHeight: '42px', borderRadius: '10px' },
  DataTable: { thColor: '#f8fafc', thTextColor: '#475569', thFontWeight: '600' }
};
</script>

<style>
:root {
  --pg-bg: #f5f7fa;
  --pg-card: #ffffff;
  --pg-border: #eceff3;
  --pg-text: #1f2937;
  --pg-muted: #6b7280;
  --pg-primary: #0ea5a4;
  --pg-sidebar: #0f172a;
}
* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  background: var(--pg-bg);
  color: var(--pg-text);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--pg-primary); text-decoration: none; }
.page { padding: 20px 24px 40px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
.page-title { font-size: 20px; font-weight: 650; letter-spacing: -0.2px; margin: 0; }
.page-desc { color: var(--pg-muted); font-size: 13px; margin-top: 4px; }
.grid { display: grid; gap: 16px; }
.muted { color: var(--pg-muted); font-size: 13px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.row { display: flex; align-items: center; gap: 10px; }
.row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wrap { flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.scrollbar-thin::-webkit-scrollbar { width: 8px; height: 8px; }
.scrollbar-thin::-webkit-scrollbar-thumb { background: #d6dbe3; border-radius: 8px; }

/* ---------- 统一卡片规范：所有页面的 n-card 共用同一套卡头与内边距 ---------- */
.card-hd { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
.card-title { font-size: 15px; font-weight: 600; color: #0f172a; letter-spacing: .2px; }
.card-meta { font-size: 12.5px; color: var(--pg-muted); font-weight: 400; }
.card-link { font-size: 12.5px !important; color: var(--pg-primary) !important; }
.card-link:hover { opacity: .8; }
.n-card { border-radius: 14px; }
.n-card > .n-card-header { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }
.n-card > .n-card__content, .n-card > .n-card-content { padding: 14px 16px 16px; }
.n-card > .n-card__footer { padding: 10px 16px; border-top: 1px solid #f1f5f9; }
@media (max-width: 720px) {
  .page { padding: 14px 14px 32px; }
  .page-title { font-size: 18px; }
}
</style>
