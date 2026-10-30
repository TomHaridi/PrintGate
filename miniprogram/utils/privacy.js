'use strict';
/* 隐私授权统一收口
 *
 * 为什么不能让每个 privacy-modal 实例各自 on / off 监听：
 *   微信全局只保留最后一次 wx.onNeedPrivacyAuthorization 注册。
 *   A 实例 detached 时调用 wx.offNeedPrivacyAuthorization()，会把 B 实例刚注册的
 *   监听一起清掉。wx.switchTab 会关闭所有非 tab 页（login 就在其中），此时 index
 *   页的组件刚 attached 完成，监听立刻被 login 的 detached 清掉 —— 之后
 *   chooseMessageFile / chooseImage 无人接管，微信直接 fail，
 *   表现就是「点了同意，但聊天文件 / 图片相册还是选不了」。
 *
 * 方案：全局只注册一次，永不反注册；拦截发生时转发给「当前前台页面」的组件实例。
 */

let bound = false;
let active = null;   // 当前前台页面的 privacy-modal 实例
let pending = null;  // { resolve } 当前待结算的一次拦截

function bindOnce() {
  if (bound) return false;
  if (typeof wx.onNeedPrivacyAuthorization !== 'function') return false;
  bound = true;
  wx.onNeedPrivacyAuthorization((resolve) => {
    // 上一次还没结算就来了新的拦截：先把旧的放行掉，否则上次的调用会永久挂起
    if (pending && typeof pending.resolve === 'function') {
      try { pending.resolve({ event: 'disagree' }); } catch (_) {}
      pending = null;
    }
    const target = active && !active.__dead && typeof active.showPrivacy === 'function' ? active : null;
    if (target) {
      pending = { resolve };
      target.showPrivacy();
      return;
    }
    // 没有可展示的页面：宁可让这次接口失败，也不能把调用挂死
    // （挂死的表现是按钮点了完全没反应，比直接失败更难排查）
    try { resolve({ event: 'disagree' }); } catch (_) {}
  });
  return true;
}

// 组件 attached / 页面再次 show 时登记为前台。微信规则是后者覆盖前者，
// 所以「最后 show 的页面」就是用户当前看到的页面。
function attach(comp) {
  bindOnce();
  if (!comp) return;
  comp.__dead = false;
  active = comp;
}

// 组件销毁：只撤销自己的前台身份，绝不动全局监听
function detach(comp) {
  if (!comp) return;
  comp.__dead = true;
  if (active === comp) active = null;
}

// 结算。buttonId 必须传：微信据此确认用户点的是官方同意按钮，
// 才会把「已同意」持久化下来，后续隐私接口不再拦截。
// 只传 event 的版本只放行「这一次」调用，不记账 —— 这正是之前反复弹窗的原因。
function settle(comp, event, buttonId) {
  const p = pending;
  pending = null;
  if (p && typeof p.resolve === 'function') {
    try { p.resolve(buttonId ? { buttonId, event } : { event }); } catch (_) {}
  }
  if (comp && !comp.__dead && typeof comp.hidePrivacy === 'function') comp.hidePrivacy();
}

function hasPending() { return !!pending; }

module.exports = { bindOnce, attach, detach, settle, hasPending };
