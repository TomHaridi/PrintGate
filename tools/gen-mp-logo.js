#!/usr/bin/env node
/**
 * PrintGate 小程序 logo 生成器
 *
 * 图标语义：打印机机身 + 从出纸槽滑出的纸（品牌 "PrintGate" 的"印"）。
 * 画布 512×512，圆角 116（≈22.7%，符合 app icon 比例），渐变 #16B3A2 → #0A7A70。
 * 同色渐变的描边/槽口用来做「负空间」，让白纸从机身里穿出来而不是贴在机身上。
 *
 * 用法：
 *   NODE_PATH=<sharp 所在 node_modules> node tools/gen-mp-logo.js
 *     → 写入 miniprogram/images/logo.png（512×512）+ C:/tmp/pg-logo-512.png（小程序头像用）
 *   ... node tools/gen-mp-logo.js --preview
 *     → 把全部历史候选画到 C:/tmp/logo-*.png，方便重新挑选
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'miniprogram', 'images', 'logo.png');
const PREVIEW_DIR = process.env.LOGO_PREVIEW_DIR || 'C:/tmp';

// 品牌色（与小程序图标主色一致）
const TEAL_0 = '#16B3A2';   // 渐变亮
const TEAL_1 = '#0A7A70';   // 渐变暗
const TEAL_SOLID = '#0F9B8E';
const WHITE = '#FFFFFF';

const bg = (r = 116) => `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${TEAL_0}"/>
      <stop offset="1" stop-color="${TEAL_1}"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.18"/>
      <stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="${r}" fill="url(#g)"/>
  <rect x="0" y="0" width="512" height="256" rx="${r}" fill="url(#gloss)"/>`;

/* ---------- 候选 1：实体打印机（现代圆角，纸从上方进、从下方出）---------- */
const v1 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 进纸（在机身后面） -->
  <rect x="163" y="104" width="186" height="150" rx="18" fill="${WHITE}" opacity="0.92"/>
  <g stroke="${TEAL_SOLID}" stroke-width="13" stroke-linecap="round" opacity="0.55">
    <line x1="196" y1="140" x2="316" y2="140"/>
    <line x1="196" y1="176" x2="270" y2="176"/>
  </g>
  <!-- 机身 -->
  <rect x="92" y="212" width="328" height="150" rx="34" fill="${WHITE}"/>
  <!-- 出纸口（拱形 = Gate） -->
  <path d="M196 362 v-18 a60 60 0 0 1 120 0 v18 z" fill="${TEAL_SOLID}"/>
  <!-- 出纸 -->
  <rect x="160" y="348" width="192" height="120" rx="16" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="13" stroke-linecap="round" opacity="0.55">
    <line x1="196" y1="392" x2="316" y2="392"/>
    <line x1="196" y1="428" x2="282" y2="428"/>
  </g>
</svg>`;

/* ---------- 候选 2：拱门 + 出纸（抽象，强调 Gate）---------- */
const v2 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 拱门：厚描边的门洞，腿落到底 -->
  <path d="M126 400 V244 a130 130 0 0 1 260 0 V400"
        fill="none" stroke="${WHITE}" stroke-width="44" stroke-linecap="round"/>
  <!-- 从门里滑出的纸 -->
  <rect x="176" y="286" width="160" height="150" rx="16" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="13" stroke-linecap="round">
    <line x1="206" y1="326" x2="306" y2="326"/>
    <line x1="206" y1="362" x2="278" y2="362"/>
    <line x1="206" y1="398" x2="296" y2="398"/>
  </g>
</svg>`;

/* ---------- 候选 3：一张纸 + 拱形缺口（纸即门）---------- */
const v3 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <path d="M136 92 h240 a24 24 0 0 1 24 24 v280 a24 24 0 0 1 -24 24 h-240 a24 24 0 0 1 -24 -24 v-280 a24 24 0 0 1 24 -24 z
           M200 420 v-84 a56 56 0 0 1 112 0 v84 z"
        fill="${WHITE}" fill-rule="evenodd"/>
  <g stroke="${TEAL_SOLID}" stroke-width="14" stroke-linecap="round">
    <line x1="176" y1="160" x2="336" y2="160"/>
    <line x1="176" y1="204" x2="336" y2="204"/>
    <line x1="176" y1="248" x2="280" y2="248"/>
  </g>
</svg>`;

/* ---------- 候选 4：打印机 + 门柱（把 Gate 做成两侧立柱）---------- */
const v4 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <rect x="96" y="118" width="320" height="196" rx="40" fill="${WHITE}"/>
  <rect x="200" y="176" width="112" height="18" rx="9" fill="${TEAL_SOLID}" opacity="0.75"/>
  <rect x="200" y="214" width="72" height="18" rx="9" fill="${TEAL_SOLID}" opacity="0.45"/>
  <!-- 门柱 -->
  <rect x="96" y="286" width="44" height="150" rx="22" fill="${WHITE}"/>
  <rect x="372" y="286" width="44" height="150" rx="22" fill="${WHITE}"/>
  <!-- 出门的纸 -->
  <rect x="176" y="300" width="160" height="136" rx="18" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.6">
    <line x1="204" y1="344" x2="308" y2="344"/>
    <line x1="204" y1="380" x2="272" y2="380"/>
  </g>
</svg>`;

/* ---------- 候选 5：机身 + 拱形出纸口（纸从门洞滑出）+ 指示灯 ---------- */
const v5 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 纸先画，被机身挡住上半部分，只从门洞和机身下方露出来 -->
  <rect x="214" y="252" width="84" height="212" rx="14" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.75">
    <line x1="238" y1="402" x2="274" y2="402"/>
    <line x1="238" y1="436" x2="262" y2="436"/>
  </g>
  <!-- 机身（中间挖出拱形门洞） -->
  <path d="M116 186 h280 a36 36 0 0 1 36 36 v134 a36 36 0 0 1 -36 36 h-280 a36 36 0 0 1 -36 -36 v-134 a36 36 0 0 1 36 -36 z
           M200 392 v-60 a56 56 0 0 1 112 0 v60 z"
        fill="${WHITE}" fill-rule="evenodd"/>
  <!-- 指示灯 -->
  <circle cx="366" cy="234" r="13" fill="${TEAL_SOLID}" opacity="0.65"/>
</svg>`;

/* ---------- 候选 6：经典打印机（纸在上进、下出），比例收紧 ---------- */
const v6 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 进纸 -->
  <rect x="176" y="104" width="160" height="132" rx="16" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.6">
    <line x1="206" y1="140" x2="306" y2="140"/>
    <line x1="206" y1="172" x2="268" y2="172"/>
  </g>
  <!-- 机身 -->
  <rect x="88" y="204" width="336" height="142" rx="32" fill="${WHITE}"/>
  <rect x="336" y="228" width="52" height="14" rx="7" fill="${TEAL_SOLID}" opacity="0.5"/>
  <rect x="200" y="292" width="112" height="14" rx="7" fill="${TEAL_SOLID}" opacity="0.45"/>
  <!-- 出纸（压在机身下沿之前） -->
  <rect x="168" y="330" width="176" height="118" rx="14" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.6">
    <line x1="200" y1="374" x2="312" y2="374"/>
    <line x1="200" y1="408" x2="272" y2="408"/>
  </g>
</svg>`;

/* ---------- 候选 7：分层打印机（用同色描边做出负空间，避免白块粘连）---------- */
const v7 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 进纸：在机身之后 -->
  <rect x="180" y="106" width="152" height="150" rx="16" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="14"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.7">
    <line x1="210" y1="150" x2="302" y2="150"/>
    <line x1="210" y1="182" x2="268" y2="182"/>
  </g>
  <!-- 机身 -->
  <rect x="76" y="226" width="360" height="132" rx="34" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="14"/>
  <circle cx="376" cy="258" r="12" fill="${TEAL_SOLID}" opacity="0.7"/>
  <!-- 出纸：压在机身之上，靠自身描边与机身分离 -->
  <rect x="166" y="330" width="180" height="118" rx="16" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="14"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.7">
    <line x1="198" y1="376" x2="314" y2="376"/>
    <line x1="198" y1="410" x2="270" y2="410"/>
  </g>
</svg>`;

/* ---------- 候选 8：拱形出纸口做在机身上（Gate），纸从拱下穿出 ---------- */
const v8 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <rect x="180" y="106" width="152" height="150" rx="16" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="14"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.7">
    <line x1="210" y1="150" x2="302" y2="150"/>
    <line x1="210" y1="182" x2="268" y2="182"/>
  </g>
  <!-- 纸从拱形口穿出：先画纸，再画带拱形缺口的机身 -->
  <rect x="204" y="300" width="104" height="150" rx="14" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.7">
    <line x1="232" y1="392" x2="280" y2="392"/>
    <line x1="232" y1="424" x2="262" y2="424"/>
  </g>
  <path d="M110 226 h292 a34 34 0 0 1 34 34 v98 a34 34 0 0 1 -34 34 h-292 a34 34 0 0 1 -34 -34 v-98 a34 34 0 0 1 34 -34 z
           M196 392 v-50 a60 60 0 0 1 120 0 v50 z"
        fill="${WHITE}" stroke="${TEAL_1}" stroke-width="14" fill-rule="evenodd"/>
  <circle cx="366" cy="258" r="12" fill="${TEAL_SOLID}" opacity="0.7"/>
</svg>`;

/* ---------- 候选 9：比例收紧的分层打印机（推荐路线）---------- */
const v9 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <rect x="186" y="104" width="140" height="146" rx="14" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="12"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.65">
    <line x1="214" y1="146" x2="298" y2="146"/>
    <line x1="214" y1="178" x2="266" y2="178"/>
  </g>
  <rect x="84" y="212" width="344" height="130" rx="32" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="12"/>
  <circle cx="374" cy="246" r="11" fill="${TEAL_SOLID}" opacity="0.6"/>
  <rect x="160" y="316" width="192" height="138" rx="14" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="12"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.65">
    <line x1="194" y1="368" x2="318" y2="368"/>
    <line x1="194" y1="404" x2="272" y2="404"/>
  </g>
</svg>`;

/* ---------- 候选 10：极简——一张纸从槽里出来的意象（纸+两道卡槽）---------- */
const v10 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 纸：带折角 -->
  <path d="M150 96 h150 l70 70 v250 a20 20 0 0 1 -20 20 h-200 a20 20 0 0 1 -20 -20 v-300 a20 20 0 0 1 20 -20 z"
        fill="${WHITE}"/>
  <path d="M300 96 v50 a20 20 0 0 0 20 20 h50 z" fill="${TEAL_1}" opacity="0.85"/>
  <g stroke="${TEAL_SOLID}" stroke-width="14" stroke-linecap="round" opacity="0.7">
    <line x1="186" y1="214" x2="330" y2="214"/>
    <line x1="186" y1="256" x2="330" y2="256"/>
    <line x1="186" y1="298" x2="266" y2="298"/>
  </g>
  <!-- 出纸槽：两条横杠夹住纸，形成 printer 感 -->
  <rect x="96" y="330" width="320" height="34" rx="17" fill="${WHITE}"/>
  <rect x="96" y="392" width="320" height="34" rx="17" fill="${WHITE}"/>
</svg>`;

/* ---------- 候选 11：出纸从「槽」里穿过（纸不贴在机身上，而是插入槽口）---------- */
const v11 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 进纸 -->
  <rect x="188" y="100" width="136" height="150" rx="14" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="12"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.6">
    <line x1="216" y1="142" x2="296" y2="142"/>
    <line x1="216" y1="174" x2="266" y2="174"/>
  </g>
  <!-- 出纸（顶部藏在机身里） -->
  <rect x="166" y="300" width="180" height="152" rx="14" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.6">
    <line x1="200" y1="382" x2="312" y2="382"/>
    <line x1="200" y1="418" x2="276" y2="418"/>
  </g>
  <!-- 机身 -->
  <rect x="84" y="210" width="344" height="132" rx="32" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="12"/>
  <circle cx="372" cy="244" r="11" fill="${TEAL_SOLID}" opacity="0.6"/>
  <!-- 出纸槽：横切一刀，纸看起来是从槽里出来的 -->
  <rect x="152" y="334" width="208" height="16" rx="8" fill="${TEAL_1}"/>
</svg>`;

/* ---------- 候选 12：同 11，但槽做成拱形门洞（Gate 意象）---------- */
const v12 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <rect x="188" y="100" width="136" height="150" rx="14" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="12"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.6">
    <line x1="216" y1="142" x2="296" y2="142"/>
    <line x1="216" y1="174" x2="266" y2="174"/>
  </g>
  <rect x="180" y="300" width="152" height="152" rx="14" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.6">
    <line x1="212" y1="382" x2="300" y2="382"/>
    <line x1="212" y1="418" x2="270" y2="418"/>
  </g>
  <rect x="84" y="210" width="344" height="132" rx="32" fill="${WHITE}" stroke="${TEAL_1}" stroke-width="12"/>
  <circle cx="372" cy="244" r="11" fill="${TEAL_SOLID}" opacity="0.6"/>
  <!-- 拱形出纸口 -->
  <path d="M166 346 v-26 a90 90 0 0 1 180 0 v26 z" fill="${TEAL_1}"/>
</svg>`;

/* ---------- 候选 13：11 号打磨（三行字 + 柔和投影 + 细节比例）---------- */
const v13 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${TEAL_0}"/>
      <stop offset="1" stop-color="${TEAL_1}"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.18"/>
      <stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="ds" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#023B36" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="116" fill="url(#g)"/>
  <rect x="0" y="0" width="512" height="256" rx="116" fill="url(#gloss)"/>

  <!-- 进纸 -->
  <g filter="url(#ds)">
    <rect x="188" y="102" width="136" height="146" rx="14" fill="${WHITE}"/>
  </g>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.55">
    <line x1="216" y1="144" x2="296" y2="144"/>
    <line x1="216" y1="176" x2="266" y2="176"/>
  </g>

  <!-- 出纸（顶部藏在机身里） -->
  <g filter="url(#ds)">
    <rect x="166" y="300" width="180" height="152" rx="14" fill="${WHITE}"/>
  </g>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.55">
    <line x1="200" y1="374" x2="312" y2="374"/>
    <line x1="200" y1="408" x2="278" y2="408"/>
    <line x1="200" y1="436" x2="252" y2="436"/>
  </g>

  <!-- 机身 -->
  <g filter="url(#ds)">
    <rect x="84" y="208" width="344" height="134" rx="32" fill="${WHITE}"/>
  </g>
  <circle cx="374" cy="242" r="11" fill="${TEAL_SOLID}" opacity="0.55"/>

  <!-- 出纸槽：横切一刀 -->
  <rect x="152" y="334" width="208" height="15" rx="7.5" fill="${TEAL_1}"/>
</svg>`;

/* ---------- 候选 14：极简机身 + 出纸（不要上方进纸，避免"三张卡片"感）---------- */
const v14 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 出纸（顶部藏在机身里） -->
  <rect x="170" y="286" width="172" height="176" rx="16" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="13" stroke-linecap="round" opacity="0.6">
    <line x1="204" y1="368" x2="308" y2="368"/>
    <line x1="204" y1="404" x2="282" y2="404"/>
    <line x1="204" y1="436" x2="252" y2="436"/>
  </g>
  <!-- 机身 -->
  <rect x="80" y="196" width="352" height="148" rx="36" fill="${WHITE}"/>
  <circle cx="374" cy="234" r="12" fill="${TEAL_SOLID}" opacity="0.55"/>
  <!-- 出纸槽 -->
  <rect x="156" y="330" width="200" height="15" rx="7.5" fill="${TEAL_1}"/>
</svg>`;

/* ---------- 候选 15：机身 + 出纸 + 顶部进纸（改为细窄的进纸口，压低层次）---------- */
const v15 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 顶部进纸：窄而高，只露出一截 -->
  <rect x="200" y="92" width="112" height="120" rx="12" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="12" stroke-linecap="round" opacity="0.5">
    <line x1="226" y1="130" x2="286" y2="130"/>
    <line x1="226" y1="160" x2="266" y2="160"/>
  </g>
  <!-- 出纸 -->
  <rect x="166" y="300" width="180" height="170" rx="16" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="13" stroke-linecap="round" opacity="0.6">
    <line x1="200" y1="378" x2="312" y2="378"/>
    <line x1="200" y1="414" x2="278" y2="414"/>
  </g>
  <!-- 机身 -->
  <rect x="80" y="200" width="352" height="146" rx="36" fill="${WHITE}"/>
  <circle cx="374" cy="238" r="12" fill="${TEAL_SOLID}" opacity="0.55"/>
  <rect x="152" y="332" width="208" height="15" rx="7.5" fill="${TEAL_1}"/>
</svg>`;

/* ---------- 候选 16（定稿）：机身 + 从出纸槽滑出的纸 ---------- */
const v16 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <!-- 出纸：顶边藏在机身里，靠下方"出纸槽"横切一刀，看起来是从缝里滑出来 -->
  <rect x="158" y="214" width="196" height="190" rx="18" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="15" stroke-linecap="round" opacity="0.7">
    <line x1="196" y1="288" x2="316" y2="288"/>
    <line x1="196" y1="326" x2="290" y2="326"/>
    <line x1="196" y1="362" x2="258" y2="362"/>
  </g>
  <!-- 机身 -->
  <rect x="74" y="136" width="364" height="152" rx="40" fill="${WHITE}"/>
  <circle cx="386" cy="176" r="12" fill="${TEAL_SOLID}" opacity="0.5"/>
  <!-- 出纸槽 -->
  <rect x="144" y="274" width="224" height="16" rx="8" fill="${TEAL_1}"/>
</svg>`;

/* ---------- 候选 17：16 号 + 纸面微色调（用两层白差做出层次，不用投影）---------- */
const v17 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <rect x="158" y="214" width="196" height="190" rx="18" fill="#E6F5F2"/>
  <g stroke="${TEAL_1}" stroke-width="14" stroke-linecap="round" opacity="0.45">
    <line x1="196" y1="304" x2="316" y2="304"/>
    <line x1="196" y1="342" x2="290" y2="342"/>
    <line x1="196" y1="376" x2="258" y2="376"/>
  </g>
  <rect x="74" y="136" width="364" height="152" rx="40" fill="${WHITE}"/>
  <circle cx="386" cy="176" r="12" fill="${TEAL_SOLID}" opacity="0.5"/>
  <rect x="144" y="274" width="224" height="16" rx="8" fill="${TEAL_1}"/>
</svg>`;

/* ---------- 候选 18：机身淡青、纸面纯白（让白纸成为视觉焦点）---------- */
const v18 = () => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  ${bg()}
  <rect x="158" y="214" width="196" height="190" rx="18" fill="${WHITE}"/>
  <g stroke="${TEAL_SOLID}" stroke-width="14" stroke-linecap="round" opacity="0.55">
    <line x1="196" y1="304" x2="316" y2="304"/>
    <line x1="196" y1="342" x2="290" y2="342"/>
    <line x1="196" y1="376" x2="258" y2="376"/>
  </g>
  <rect x="74" y="136" width="364" height="152" rx="40" fill="#E3F3F0"/>
  <circle cx="386" cy="176" r="12" fill="${TEAL_1}" opacity="0.45"/>
  <rect x="144" y="274" width="224" height="16" rx="8" fill="${TEAL_1}"/>
</svg>`;

const VARIANTS = { 1: v1, 2: v2, 3: v3, 4: v4, 5: v5, 6: v6, 7: v7, 8: v8, 9: v9, 10: v10,
  11: v11, 12: v12, 13: v13, 14: v14, 15: v15, 16: v16, 17: v17, 18: v18 };

// 定稿：16 号（纯白机身 + 纯白出纸，最干净、小尺寸最清晰）
const FINAL = 16;

(async () => {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  if (process.argv.includes('--preview')) {
    for (const [n, fn] of Object.entries(VARIANTS)) {
      const buf = await sharp(Buffer.from(fn())).resize(512, 512).png({ compressionLevel: 9 }).toBuffer();
      fs.writeFileSync(path.join(PREVIEW_DIR, `logo-${n}.png`), buf);
    }
    console.log(`候选已生成到 ${PREVIEW_DIR}/logo-*.png`);
    return;
  }

  const svg = VARIANTS[FINAL]();
  const png = await sharp(Buffer.from(svg)).resize(512, 512).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(OUT, png);

  // 小程序头像（微信公众平台后台上传）：正方形、≤2MB，512 足够
  const avatar = path.join(PREVIEW_DIR, 'pg-logo-512.png');
  fs.writeFileSync(avatar, png);

  console.log(`已写入 ${OUT}（${(png.length / 1024).toFixed(1)} KB，512×512，候选 ${FINAL}）`);
  console.log(`头像备用 ${avatar}`);
})();
