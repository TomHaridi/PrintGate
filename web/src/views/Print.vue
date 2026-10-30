<template>
  <div class="page" :class="{ standalone: isUser }">
    <div class="page-head">
      <div>
        <h1 class="page-title">{{ isUser ? '打印工作台' : '发起打印' }}</h1>
        <div class="page-desc">
          {{ isUser ? '标准文档、文字速印、发票与证件合排都能用；只能看到和操作自己的文件与任务' : '标准文档、纯文字速印、发票与证件合排，都在这一页发到 CUPS 队列' }}
        </div>
      </div>
      <div class="row wrap">
        <n-tag v-if="approveEachJob" type="warning" :bordered="false" size="small">
          逐单审批已开启：提交后需管理员放行
        </n-tag>
        <n-button v-if="isUser" size="small" quaternary @click="goPortal">← 返回门户</n-button>
      </div>
    </div>

    <n-alert v-if="advancedHidden" type="info" :bordered="false" style="margin-bottom: 12px">
      管理员已隐藏详细打印设置：页面上仍可改的项会生效，未显示的按默认值（单份 / 黑白 / 单面 / A4）提交。
    </n-alert>

    <!-- 顶部：目标打印机 + 服务状态 -->
    <div class="print-bar">
      <div class="row wrap" style="gap: 10px">
        <span class="bar-label">目标打印机</span>
        <n-select
          v-model:value="opt.printer" :options="printerOptions" size="small"
          style="width: 280px" placeholder="选择打印机队列" @update:value="onPrinterChange"
        />
        <n-tag size="small" :type="cupsOk ? 'success' : 'error'" :bordered="false">
          <template #icon><n-icon :component="PrintOutline" /></template>
          {{ cupsOk ? 'CUPS 服务正常' : 'CUPS 未就绪' }}
        </n-tag>
        <n-tag v-if="printerState" size="small" :type="printerState.type" :bordered="false">
          {{ printerState.text }}
        </n-tag>
      </div>
      <div class="row" style="gap: 8px">
        <n-button size="small" quaternary :loading="loadingDetail" @click="loadDetail">
          <template #icon><n-icon :component="RefreshOutline" /></template>刷新状态
        </n-button>
      </div>
    </div>

    <div class="layout">
      <!-- 左栏 -->
      <div class="col">
        <div class="mode-tabs">
          <button
            v-for="m in MODES" :key="m.key" type="button"
            class="mt-item" :class="{ on: mode === m.key }" @click="switchMode(m.key)"
          >
            <n-icon :component="m.icon" :size="15" />{{ m.label }}
          </button>
        </div>

        <!-- 标准打印 -->
        <n-card v-if="mode === 'standard'" size="small" class="block">
          <n-upload
            :custom-request="doUpload" :show-file-list="false" :disabled="uploading"
            accept=".pdf,.jpg,.jpeg,.png,.bmp,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          >
            <n-upload-dragger>
              <div class="drop">
                <n-icon :component="CloudUploadOutline" :size="36" style="color: #0ea5a4" />
                <div class="drop-title">{{ uploading ? '正在上传…' : '点击或拖拽文件到此处' }}</div>
                <div class="muted">支持 PDF / 图片 / Word / Excel / PPT / TXT · 单个 ≤ {{ maxFileMB }} MB</div>
              </div>
            </n-upload-dragger>
          </n-upload>

          <div v-if="current" class="picked">
            <n-icon :component="DocumentTextOutline" :size="20" style="color: #0f766e" />
            <div class="grow" style="min-width: 0">
              <div class="picked-name">{{ current.filename }}</div>
              <div class="muted" style="font-size: 12px">
                {{ fmtBytes(current.size) }}<span v-if="current.pages"> · {{ current.pages }} 页</span>
              </div>
            </div>
            <n-button size="tiny" quaternary @click="clearCurrent">移除</n-button>
          </div>

          <n-divider style="margin: 14px 0">或从最近上传选择</n-divider>
          <div v-if="files.length" class="filelist">
            <div
              v-for="f in files" :key="f.id" class="fileitem"
              :class="{ active: current?.id === f.id }" @click="pickFile(f)"
            >
              <div class="grow" style="min-width: 0">
                <div class="fi-name">{{ f.filename }}</div>
                <div class="muted" style="font-size: 11.5px">
                  {{ fmtBytes(f.size) }}<span v-if="f.pages"> · {{ f.pages }} 页</span> · {{ fmtTime(f.created_at) }}
                </div>
              </div>
              <n-button size="tiny" quaternary @click.stop="removeFile(f)">
                <template #icon><n-icon :component="TrashOutline" /></template>
              </n-button>
            </div>
          </div>
          <n-empty v-else description="暂无历史文件" size="small" style="padding: 6px 0 10px" />
        </n-card>

        <!-- 文字速印 -->
        <n-card v-else-if="mode === 'text'" size="small" class="block">
          <n-form label-placement="top" :show-feedback="false">
            <n-form-item label="标题（可选）">
              <n-input v-model:value="textForm.title" placeholder="例如：取件码 / 交接单" :maxlength="60" />
            </n-form-item>
            <n-form-item label="正文">
              <n-input
                v-model:value="textForm.body" type="textarea" :rows="10"
                placeholder="直接输入要打印的文字，支持中文与自动换行、自动分页"
              />
            </n-form-item>
            <div class="grid3">
              <n-form-item label="字号">
                <n-input-number v-model:value="textForm.fontSize" size="small" :min="6" :max="48" style="width: 100%" />
              </n-form-item>
              <n-form-item label="行距">
                <n-input-number v-model:value="textForm.lineGap" size="small" :min="0" :max="30" style="width: 100%" />
              </n-form-item>
              <n-form-item label="页边距 (pt)">
                <n-input-number v-model:value="textForm.margin" size="small" :min="20" :max="120" style="width: 100%" />
              </n-form-item>
            </div>
          </n-form>
          <div class="muted" style="font-size: 12px">已输入 {{ textForm.body.length }} 字符 · 超出页高会自动分页</div>
        </n-card>

        <!-- 发票打印 -->
        <n-card v-else-if="mode === 'invoice'" size="small" class="block">
          <n-upload :custom-request="doUploadMany" :show-file-list="false" multiple accept=".jpg,.jpeg,.png,.pdf">
            <n-upload-dragger>
              <div class="drop">
                <n-icon :component="ImagesOutline" :size="34" style="color: #0ea5a4" />
                <div class="drop-title">上传发票图片或 PDF（可多选）</div>
                <div class="muted">JPG / PNG / PDF · PDF 会先逐页转图，再按下方「每页张数」自动拼到 A4 上</div>
              </div>
            </n-upload-dragger>
          </n-upload>

          <div v-if="images.length" class="thumbs">
            <div v-for="(im, i) in images" :key="im.id" class="thumb">
              <img :src="im.url" alt="" />
              <span class="thumb-idx">{{ i + 1 }}</span>
              <n-button class="thumb-del" size="tiny" circle quaternary @click="removeImage(i)">
                <template #icon><n-icon :component="CloseOutline" /></template>
              </n-button>
            </div>
          </div>
          <div class="row" style="margin-top: 12px; gap: 10px">
            <span class="muted" style="font-size: 12.5px">每页张数</span>
            <n-radio-group v-model:value="invForm.perPage" size="small">
              <n-radio-button :value="1">1 张</n-radio-button>
              <n-radio-button :value="2">2 张</n-radio-button>
              <n-radio-button :value="4">4 张</n-radio-button>
            </n-radio-group>
            <n-tag v-if="images.length" size="tiny" :bordered="false" type="info">
              共 {{ images.length }} 张 · {{ Math.ceil(images.length / invForm.perPage) }} 页
            </n-tag>
          </div>
        </n-card>

        <!-- 身份证打印 -->
        <n-card v-else size="small" class="block">
          <div class="idcard-grid">
            <div class="idcard-slot" @click="pickIdcard('front')">
              <img v-if="idForm.front?.url" :src="idForm.front.url" alt="" />
              <template v-else>
                <n-icon :component="PersonOutline" :size="28" style="color: #94a3b8" />
                <div class="slot-title">人像面</div>
                <div class="muted" style="font-size: 11.5px">点击上传</div>
              </template>
            </div>
            <div class="idcard-slot" @click="pickIdcard('back')">
              <img v-if="idForm.back?.url" :src="idForm.back.url" alt="" />
              <template v-else>
                <n-icon :component="CardOutline" :size="28" style="color: #94a3b8" />
                <div class="slot-title">国徽面</div>
                <div class="muted" style="font-size: 11.5px">点击上传</div>
              </template>
            </div>
          </div>
          <input ref="idInput" type="file" accept=".jpg,.jpeg,.png" style="display: none" @change="onIdFile" />
          <div class="row" style="margin-top: 10px; gap: 8px; align-items: center">
            <n-button
              v-if="idForm.front || idForm.back" size="small" type="primary" secondary
              :loading="cropping" @click="autoCropId"
            >
              <template #icon><n-icon :component="CropOutline" /></template>
              一键矫正识别切割
            </n-button>
            <span class="muted" style="font-size: 12px">自动找出身份证、旋转摆正并裁掉背景</span>
          </div>

          <!-- 大小 / 方向调节（实时重排预览） -->
          <div v-if="idForm.front || idForm.back" class="id-layout">
            <div v-for="side in ['front', 'back']" :key="side" class="id-layout-row">
              <span class="id-layout-label">{{ side === 'front' ? '人像面' : '国徽面' }}</span>
              <n-tag v-if="!idForm[side]" size="tiny" :bordered="false" type="default">未上传</n-tag>
              <template v-else>
                <n-button size="tiny" quaternary @click="rotateId(side)">
                  <template #icon><n-icon :component="RefreshOutline" /></template>
                  旋转 {{ idLayout[side].rotate }}°
                </n-button>
                <span class="muted" style="font-size: 12px">缩放</span>
                <n-slider v-model:value="idLayout[side].scale" :min="0.5" :max="1.5" :step="0.05" style="width: 130px" />
                <span class="muted mono" style="font-size: 12px; width: 40px">{{ (idLayout[side].scale * 100).toFixed(0) }}%</span>
              </template>
            </div>
          </div>

          <div class="muted" style="font-size: 12px; margin-top: 8px">
            正反面会按原比例居中排在同一张 {{ opt.media }} 上，沿虚线剪开即可。
            <n-button v-if="idForm.front || idForm.back" size="tiny" quaternary @click="resetId">清空</n-button>
          </div>
        </n-card>

        <!-- 打印参数 -->
        <n-card size="small" class="block">
          <template #header>
            <div class="row-between">
              <div class="row" style="gap: 8px">
                <n-icon :component="OptionsOutline" :size="17" style="color: #0f766e" />
                <span>打印参数</span>
              </div>
              <n-button size="tiny" quaternary @click="resetPrefs">恢复默认</n-button>
            </div>
          </template>

          <div class="field-label">颜色模式</div>
          <div class="seg">
            <button class="seg-item" :class="{ on: opt.color === 'color' }" @click="opt.color = 'color'">
              <n-icon :component="ColorPaletteOutline" /> 彩色打印
            </button>
            <button class="seg-item" :class="{ on: opt.color === 'mono' }" @click="opt.color = 'mono'">
              <n-icon :component="ContrastOutline" /> 黑白打印
            </button>
          </div>

          <div class="grid2" style="margin-top: 12px">
            <n-form-item label="双面打印" :show-feedback="false">
              <n-select v-model:value="opt.sides" size="small" :options="[
                { label: '单面打印', value: 'one-sided' },
                { label: '双面（长边翻页）', value: 'two-sided-long-edge' },
                { label: '双面（短边翻页）', value: 'two-sided-short-edge' }
              ]" />
            </n-form-item>
            <n-form-item label="份数" :show-feedback="false">
              <n-input-number v-model:value="opt.copies" size="small" :min="1" :max="maxCopies" style="width: 100%" />
            </n-form-item>
          </div>

          <n-collapse :default-expanded-names="['adv']" style="margin-top: 6px">
            <n-collapse-item name="adv">
              <template #header>
                <!-- 箭头由 n-collapse 自带，自己再加一个会出现双箭头 -->
                <span style="font-size: 13px; font-weight: 500">高级选项</span>
              </template>
              <template #header-extra>
                <n-button size="tiny" quaternary :loading="loadingDetail" @click.stop="loadDetail">
                  <template #icon><n-icon :component="RefreshOutline" /></template>刷新选项
                </n-button>
              </template>

              <div class="grid2">
                <n-form-item label="纸张大小" :show-feedback="false">
                  <n-select v-model:value="opt.media" size="small" :options="mediaOptions" />
                </n-form-item>
                <n-form-item label="介质类型" :show-feedback="false">
                  <n-select v-model:value="opt.mediaType" size="small" clearable :options="mediaTypeOptions" placeholder="普通纸" />
                </n-form-item>
              </div>

              <div class="grid2">
                <n-form-item label="打印质量" :show-feedback="false">
                  <n-select v-model:value="opt.resolution" size="small" clearable :options="resolutionOptions" placeholder="打印机默认" />
                </n-form-item>
                <n-form-item label="进纸盒" :show-feedback="false">
                  <n-select v-model:value="opt.inputSlot" size="small" clearable :options="slotOptions" placeholder="自动选择" />
                </n-form-item>
              </div>

              <div class="grid2">
                <n-form-item label="缩放" :show-feedback="false">
                  <n-select v-model:value="opt.scaling" size="small" :options="[
                    { label: '自动', value: 'auto' }, { label: '适合页面', value: 'fit' },
                    { label: '铺满页面', value: 'fill' }, { label: '不缩放', value: 'none' }
                  ]" />
                </n-form-item>
                <n-form-item label="页面范围（留空=全部）" :show-feedback="false">
                  <n-input v-model:value="opt.pageRanges" size="small" placeholder="如：1-5,8" />
                </n-form-item>
              </div>

              <n-form-item label="每页页数（多页缩到一张）" :show-feedback="false">
                <n-select v-model:value="opt.numberUp" size="small" :options="[
                  { label: '1 页/张（不缩排）', value: 1 }, { label: '2 页/张', value: 2 },
                  { label: '4 页/张', value: 4 }, { label: '6 页/张', value: 6 }, { label: '9 页/张', value: 9 }
                ]" />
              </n-form-item>

              <div class="field-label">页面子集</div>
              <n-radio-group v-model:value="opt.pageSet" size="small" class="subset">
                <n-radio-button value="all">
                  <template #icon><n-icon :component="GridOutline" /></template>全部页
                </n-radio-button>
                <n-radio-button value="odd">
                  <template #icon><n-icon :component="ListOutline" /></template>奇数页
                </n-radio-button>
                <n-radio-button value="even">
                  <template #icon><n-icon :component="ListOutline" /></template>偶数页
                </n-radio-button>
                <n-radio-button value="even-reverse">
                  <template #icon><n-icon :component="SwapVerticalOutline" /></template>偶数页倒序
                </n-radio-button>
              </n-radio-group>

              <div class="row" style="margin-top: 14px; gap: 10px">
                <n-checkbox v-model:checked="opt.mirror" size="small">镜像打印（水平翻转）</n-checkbox>
              </div>

              <n-form-item label="水印文字（留空=不添加）" style="margin-top: 12px" :show-feedback="false">
                <n-input
                  v-model:value="opt.watermark" size="small" :maxlength="40"
                  placeholder="如：内部资料 严禁外传"
                />
              </n-form-item>
              <div class="muted" style="font-size: 11.5px">
                水印会叠加到 PDF 每一页（斜向平铺、浅色不遮正文）；图片与 Office 转换件同样适用。
              </div>

              <n-form-item label="自定义 CUPS 参数（每行 key=value）" style="margin-top: 12px" :show-feedback="false">
                <n-input v-model:value="extraText" type="textarea" :rows="2" placeholder="Resolution=600dpi&#10;Duplex=DuplexNoTumble" />
              </n-form-item>
            </n-collapse-item>
          </n-collapse>

          <n-alert v-if="!printerOptions.length" type="warning" :bordered="false" style="margin: 10px 0 0">
            还没有可用打印机，请先到「打印机」页添加队列。
          </n-alert>

          <n-button
            type="primary" block size="large" :loading="submitting" :disabled="!canSubmit"
            style="margin-top: 16px" @click="submit"
          >
            <template #icon><n-icon :component="PrintOutline" /></template>
            {{ submitting ? '正在发送…' : '开始打印' }}
          </n-button>
          <div class="muted" style="margin-top: 8px; font-size: 12px; text-align: center">
            实际输出以打印机驱动支持为准，不支持的参数会被 CUPS 忽略
          </div>
        </n-card>
      </div>

      <!-- 右栏 -->
      <div class="col">
        <n-card size="small" class="block">
          <template #header>
            <div class="row-between">
              <div class="row" style="gap: 8px">
                <n-icon :component="EyeOutline" :size="17" style="color: #0f766e" />
                <span>预览</span>
                <n-tag v-if="opt.color === 'color'" size="tiny" type="success" :bordered="false">彩色</n-tag>
                <n-tag v-else size="tiny" :bordered="false">黑白</n-tag>
                <div class="orient">
                  <button
                    type="button" class="og" :class="{ on: opt.orientation === 'portrait' }"
                    title="纵向打印（预览按纵向显示）"
                    @click="opt.orientation = 'portrait'"
                  >纵向</button>
                  <button
                    type="button" class="og" :class="{ on: opt.orientation === 'landscape' }"
                    title="横向打印（预览按横向显示）"
                    @click="opt.orientation = 'landscape'"
                  >横向</button>
                </div>
              </div>
              <span class="muted" style="font-size: 12px">{{ mediaSizeText }}</span>
            </div>
          </template>
          <div class="preview">
            <img v-if="previewUrl" :src="previewUrl" alt="预览" class="preview-img" :class="{ rotated: opt.orientation === 'landscape' }" />
            <div v-if="previewUrl && previewTotal > 1" class="pv-pagebar">
              <n-button size="tiny" quaternary :disabled="previewPage <= 1" @click="goPreviewPage(-1)">上一页</n-button>
              <span class="pv-pageno">{{ previewPage }} / {{ previewTotal }}</span>
              <n-button size="tiny" quaternary :disabled="previewPage >= previewTotal" @click="goPreviewPage(1)">下一页</n-button>
            </div>
            <div v-else class="preview-empty">
              <n-icon :component="EyeOffOutline" :size="26" style="color: #cbd5e1" />
              <div class="muted" style="font-size: 12.5px; margin-top: 8px">{{ previewHint }}</div>
            </div>
          </div>
        </n-card>

        <n-card size="small" class="block">
          <template #header>
            <div class="row-between">
              <div class="row" style="gap: 8px">
                <n-icon :component="TimeOutline" :size="17" style="color: #0f766e" />
                <span>打印记录</span>
              </div>
              <n-button size="tiny" quaternary @click="loadTasks">
                <template #icon><n-icon :component="RefreshOutline" /></template>
              </n-button>
            </div>
          </template>
          <div v-if="tasks.length" class="rec-list">
            <div v-for="t in tasks" :key="t.id" class="rec">
              <div class="grow" style="min-width: 0">
                <div class="rec-name">{{ t.filename || '（文件已清理）' }}</div>
                <div class="muted rec-meta">
                  {{ t.printer }} · {{ t.pages || 1 }} 页 · {{ fmtTime(t.created_at) }}
                </div>
              </div>
              <n-tag size="tiny" :type="statusType(t.status)" :bordered="false">{{ statusText(t.status) }}</n-tag>
            </div>
          </div>
          <n-empty v-else description="还没有打印记录" style="padding: 18px 0" />
        </n-card>

        <n-card size="small" class="block">
          <template #header>
            <div class="row" style="gap: 8px">
              <n-icon :component="PulseOutline" :size="17" style="color: #0f766e" />
              <span>打印机状态</span>
            </div>
          </template>

          <div class="stat-row">
            <span class="stat-k">打印机状态</span>
            <span class="stat-v">{{ printerState?.text || '未知' }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-k">队列任务数</span>
            <span class="stat-v">{{ detail?.queuedJobs ?? 0 }} 个</span>
          </div>
          <div class="stat-row">
            <span class="stat-k">型号</span>
            <span class="stat-v mono" style="font-size: 11.5px">{{ detail?.model || '未上报' }}</span>
          </div>

          <n-divider style="margin: 12px 0" />
          <div class="field-label" style="margin-bottom: 8px">墨盒信息</div>
          <div v-if="detail?.markers?.length" class="markers">
            <div v-for="m in detail.markers" :key="m.name" class="marker">
              <div class="marker-head">
                <span class="marker-name">{{ m.name }}</span>
                <span class="muted" style="font-size: 11.5px">{{ m.level === null ? '未知' : m.level + '%' }}</span>
              </div>
              <n-progress
                type="line" :percentage="m.level ?? 0" :show-indicator="false" :height="7"
                :color="levelColor(m)" :rail-color="'#eef2f7'"
              />
            </div>
          </div>
          <div v-else class="muted" style="font-size: 12.5px">
            {{ detail?.ipp ? '该打印机未上报耗材信息' : '未取到设备信息（虚拟打印机或设备离线）' }}
          </div>

          <n-divider style="margin: 12px 0" />
          <div class="field-label" style="margin-bottom: 8px">纸盒信息</div>
          <div v-if="detail?.mediaReady?.length" class="row wrap" style="gap: 6px">
            <n-tag v-for="m in detail.mediaReady" :key="m" size="small" :bordered="false">{{ m }}</n-tag>
          </div>
          <div v-else class="muted" style="font-size: 12.5px">未上报已装纸张</div>
        </n-card>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import {
  CloudUploadOutline, DocumentTextOutline, TrashOutline, PrintOutline, RefreshOutline,
  OptionsOutline, ColorPaletteOutline, ContrastOutline, GridOutline,
  ListOutline, SwapVerticalOutline, EyeOutline, EyeOffOutline, TimeOutline, PulseOutline,
  ImagesOutline, CloseOutline, PersonOutline, CardOutline, CreateOutline, ReceiptOutline, CropOutline
} from '@vicons/ionicons5';
import { api, fmtBytes, fmtTime } from '../api';
import { store } from '../store';
import { useRouter } from 'vue-router';

const message = useMessage();
const router = useRouter();
// 普通用户复用同一页：数据范围由后端按 user_id 隔离，界面只多加一个「返回门户」
const isUser = computed(() => store.role === 'user');
function goPortal() { router.push({ name: 'portal' }); }
// 管理员可对普通用户关闭「详细打印设置」，工作台仍可用，但只留基础参数
const advancedHidden = ref(false);
const uploading = ref(false);
const submitting = ref(false);
const loadingDetail = ref(false);
const files = ref([]);
const current = ref(null);
const printers = ref([]);
const settings = ref({ print: { maxFileMB: 200, maxCopies: 10, approveEachJob: false } });
const cupsOk = ref(true);
const detail = ref(null);
const tasks = ref([]);
const mode = ref('standard');
const previewUrl = ref('');
const previewPage = ref(1);
const previewTotal = ref(0);
const extraText = ref('');

const images = ref([]);          // 发票：已选图片 [{id,url,filename}]
const idForm = reactive({ front: null, back: null });
const idLayout = reactive({ front: { rotate: 0, scale: 1 }, back: { rotate: 0, scale: 1 } });
const idTarget = ref('front');
const idInput = ref(null);
const textForm = reactive({ title: '', body: '', fontSize: 12, lineGap: 5, margin: 56 });
const invForm = reactive({ perPage: 2 });

const opt = reactive({
  printer: '', copies: 1, color: 'mono', sides: 'one-sided', media: 'A4',
  orientation: 'portrait', scaling: 'fit', pageRanges: '', numberUp: 1,
  mediaType: null, inputSlot: null, resolution: null, pageBorder: false,
  pageSet: 'all', mirror: false, watermark: ''
});

const MODES = [
  { key: 'standard', label: '标准打印', icon: PrintOutline },
  { key: 'text', label: '文字速印', icon: CreateOutline },
  { key: 'invoice', label: '发票打印', icon: ReceiptOutline },
  { key: 'idcard', label: '身份证打印', icon: CardOutline }
];

const maxFileMB = computed(() => settings.value.print?.maxFileMB || 200);
const maxCopies = computed(() => settings.value.print?.maxCopies || 10);
const approveEachJob = computed(() => !!settings.value.print?.approveEachJob);
const printerOptions = computed(() => printers.value.map((p) => ({
  label: `${p.name}${p.isDefault ? '（默认）' : ''}${p.state === 'stopped' ? '（已停用）' : ''}`,
  value: p.name
})));

const mediaOptions = computed(() => {
  const o = optByKey('PageSize');
  if (o?.values?.length) return o.values.map((v) => ({ label: v.label, value: v.value }));
  return [
    { label: 'A4', value: 'A4' }, { label: 'A3', value: 'A3' }, { label: 'A5', value: 'A5' },
    { label: 'A6', value: 'A6' }, { label: 'Letter', value: 'Letter' }, { label: 'Legal', value: 'Legal' },
    { label: 'B5', value: 'B5' }, { label: '16K', value: '16K' }
  ];
});
const MEDIA_MM = {
  A4: '210 × 297 mm', A3: '297 × 420 mm', A5: '148 × 210 mm', A6: '105 × 148 mm',
  Letter: '216 × 279 mm', Legal: '216 × 356 mm', B5: '176 × 250 mm', '16K': '184 × 260 mm'
};
const mediaSizeText = computed(() => {
  const mm = MEDIA_MM[opt.media] || '';
  return mm ? `${opt.media} · ${mm}` : String(opt.media || '');
});

// 驱动上报的可选项优先，其次退回内置常用值
const optByKey = (key) => (detail.value?.options || []).find((o) => o.key.toLowerCase() === key.toLowerCase());
const mediaTypeOptions = computed(() => {
  const o = optByKey('MediaType');
  if (o) return o.values.map((v) => ({ label: v.label, value: v.value }));
  return [
    { label: '普通纸', value: 'stationery' }, { label: '照片纸', value: 'photographic' },
    { label: '标签纸', value: 'labels' }, { label: '信封', value: 'envelope' }
  ];
});
const resolutionOptions = computed(() => {
  const o = optByKey('Resolution');
  if (o) return o.values.map((v) => ({ label: v.label, value: v.value }));
  return [300, 600, 1200].map((d) => ({ label: `${d} dpi`, value: `${d}dpi` }));
});
const slotOptions = computed(() => {
  const o = optByKey('InputSlot');
  if (o) return o.values.map((v) => ({ label: v.label, value: v.value }));
  if (detail.value?.mediaSources?.length) return detail.value.mediaSources.map((v) => ({ label: v, value: v }));
  return [{ label: '自动选择', value: 'Auto' }, { label: '纸盒 1', value: 'Tray1' }, { label: '手动进纸', value: 'Manual' }];
});

const printerState = computed(() => {
  const p = printers.value.find((x) => x.name === opt.printer);
  if (!p) return null;
  if (p.state === 'stopped') return { text: '已停用', type: 'error' };
  if (p.state === 'printing') return { text: '正在打印', type: 'info' };
  return { text: '空闲就绪', type: 'success' };
});

const previewHint = computed(() => {
  if (!opt.printer) return '先选择打印机';
  if (mode.value === 'standard') return current.value ? '正在生成预览…' : '上传文件后显示预览';
  if (mode.value === 'text') return '输入文字后自动生成预览';
  if (mode.value === 'invoice') return images.value.length ? '正在生成预览…' : '上传发票图片或 PDF 后显示预览';
  return idForm.front || idForm.back ? '正在生成预览…' : '上传身份证正反面后显示预览';
});

const canSubmit = computed(() => {
  if (!opt.printer) return false;
  if (mode.value === 'standard') return !!current.value;
  if (mode.value === 'text') return !!textForm.body.trim();
  if (mode.value === 'invoice') return images.value.length > 0;
  return !!(idForm.front || idForm.back);
});

async function load() {
  try {
    // 普通用户没有 /settings 权限：打印机、限制、是否显示高级参数统一从 /print/meta 取
    const [p, s, f] = await Promise.all([
      api.get('/printers'),
      isUser.value ? api.get('/print/meta') : api.get('/settings'),
      api.get('/files')
    ]);
    printers.value = p.printers || [];
    cupsOk.value = !!p.cups?.running;
    settings.value = s.settings || settings.value;
    if (isUser.value && s.advanced === false) advancedHidden.value = true;
    files.value = f.files || [];

    // 队列可能被停用或拒收：优先落到一台真能打的机器上，
    // 否则用户选着"已停用"的默认队列点打印，只会卡在队列里。
    const usable = (x) => x.enabled !== false && x.accepting !== false && x.state !== 'stopped';
    const preferred = printers.value.find((x) => x.isDefault);
    const current = printers.value.find((x) => x.name === opt.printer);

    if (!opt.printer || !current) {
      opt.printer = (preferred && usable(preferred) ? preferred : printers.value.find(usable) || preferred || printers.value[0])?.name || '';
    } else if (!usable(current)) {
      const alt = printers.value.find(usable);
      if (alt) {
        opt.printer = alt.name;
        message.warning(`「${current.name}」当前不可用，已切换到「${alt.name}」`);
      }
    }
    if (opt.printer) await loadDetail();
  } catch (e) {
    message.error(e.message);
  }
}

async function loadDetail() {
  if (!opt.printer) { detail.value = null; return; }
  loadingDetail.value = true;
  try {
    const d = await api.get(`/printers/${encodeURIComponent(opt.printer)}/detail`);
    detail.value = d.detail || null;
  } catch (e) {
    detail.value = null;
  } finally {
    loadingDetail.value = false;
  }
}

async function onPrinterChange() {
  await loadDetail();
}

async function loadTasks() {
  try {
    const d = await api.get('/tasks?size=5');
    tasks.value = (d.tasks || d.rows || []).slice(0, 5);
  } catch (_) { /* 记录区失败不影响打印 */ }
}

function statusText(s) {
  return ({ pending: '待审批', approved: '已通过', printing: '打印中', done: '已完成', failed: '失败', canceled: '已取消' })[s] || s;
}
function statusType(s) {
  return ({ pending: 'warning', approved: 'info', printing: 'info', done: 'success', failed: 'error', canceled: 'default' })[s] || 'default';
}
function levelColor(m) {
  if (m.level === null) return '#cbd5e1';
  if (m.level <= 10) return '#ef4444';
  if (m.level <= 30) return '#f59e0b';
  if (m.color) return m.color;
  return '#0ea5a4';
}

async function uploadOne(file) {
  const fd = new FormData();
  fd.append('file', file.file || file);
  const d = await api.post('/files', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 });
  return d.file;
}

async function doUpload({ file, onFinish, onError }) {
  uploading.value = true;
  try {
    const f = await uploadOne(file);
    current.value = f;
    message.success('上传成功');
    onFinish();
    await load();
  } catch (e) {
    message.error(e.message);
    onError();
  } finally {
    uploading.value = false;
  }
}

async function doUploadMany({ file, onFinish, onError }) {
  uploading.value = true;
  try {
    const f = await uploadOne(file);
    const url = await fetchPreview(f.id);
    images.value.push({ ...f, url });
    onFinish();
    await loadTasks();
  } catch (e) {
    message.error(e.message);
    onError();
  } finally {
    uploading.value = false;
  }
}

function removeImage(i) { images.value.splice(i, 1); }

function pickIdcard(which) {
  idTarget.value = which;
  idInput.value?.click();
}

async function onIdFile(ev) {
  const f = ev.target.files?.[0];
  ev.target.value = '';
  if (!f) return;
  uploading.value = true;
  try {
    const rec = await uploadOne({ file: f });
    const url = await fetchPreview(rec.id);
    idForm[idTarget.value] = { ...rec, url };
    idLayout[idTarget.value] = { rotate: 0, scale: 1 };
  } catch (e) {
    message.error(e.message);
  } finally {
    uploading.value = false;
  }
}

function resetId() {
  idForm.front = null; idForm.back = null;
  idLayout.front = { rotate: 0, scale: 1 };
  idLayout.back = { rotate: 0, scale: 1 };
}

// 每次点旋转 +90°，实时重排预览
function rotateId(side) {
  idLayout[side].rotate = (idLayout[side].rotate + 90) % 360;
}

const cropping = ref(false);
// 一键矫正：对已上传的正/反面逐张做「识别 + 摆正 + 切割」，成功后替换原图并刷新预览
async function autoCropId() {
  const targets = [];
  if (idForm.front) targets.push(['front', idForm.front]);
  if (idForm.back) targets.push(['back', idForm.back]);
  if (!targets.length) { message.warning('请先上传身份证正反面'); return; }
  cropping.value = true;
  let done = 0;
  try {
    for (const [key, img] of targets) {
      const d = await api.post('/print/idcard/auto-crop', { fileId: img.id }, { timeout: 60000 });
      const url = await fetchPreview(d.file.id);
      idForm[key] = { ...d.file, url };
      idLayout[key] = { rotate: 0, scale: 1 }; // 矫正后已是摆正的
      done++;
    }
    message.success(`已矫正 ${done} 张身份证照片`);
    refreshPreview();
  } catch (e) {
    message.error(e.message);
  } finally {
    cropping.value = false;
  }
}

async function fetchPreview(id, page = 1) {
  const blob = await api.get(`/files/${id}/preview?page=${page}`, { responseType: 'blob' });
  return URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
}

async function goPreviewPage(delta) {
  const id = mode.value === 'standard' ? current.value?.id : images.value[0]?.id;
  if (!id) return;
  const next = previewPage.value + delta;
  if (next < 1 || (previewTotal.value && next > previewTotal.value)) return;
  previewPage.value = next;
  if (previewUrl.value) { URL.revokeObjectURL(previewUrl.value); previewUrl.value = ''; }
  previewUrl.value = await fetchPreview(id, next);
}

async function refreshPreview() {
  if (previewUrl.value) { URL.revokeObjectURL(previewUrl.value); previewUrl.value = ''; }
  try {
    // 身份证：正反面拼接成一张 A4 的实时预览（可调大小/方向）
    if (mode.value === 'idcard') { await refreshIdcardPreview(); return; }
    let id = null;
    if (mode.value === 'standard') id = current.value?.id;
    else if (mode.value === 'invoice') id = images.value[0]?.id;
    if (id) {
      previewPage.value = 1;
      const cur = mode.value === 'standard' ? current.value : images.value[0];
      previewTotal.value = Number(cur && cur.pages) || 0;
      previewUrl.value = await fetchPreview(id, 1);
      return;
    }
    // 文字模式没有已上传文件，改为把表单内容实时排版后取第一页
    if (mode.value === 'text') await refreshTextPreview();
  } catch (_) { /* 预览失败不打断 */ }
}

// 身份证拼接预览：把正/反面按各自的旋转、缩放拼到同一张纸上取第一页
function cardSpec(img, layout) {
  if (!img) return null;
  return { fileId: img.id, rotate: layout?.rotate || 0, scale: layout?.scale || 1 };
}
async function refreshIdcardPreview() {
  if (mode.value !== 'idcard') return;
  if (!idForm.front && !idForm.back) return;
  try {
    const blob = await api.post('/print/idcard/preview', {
      media: opt.media,
      front: cardSpec(idForm.front, idLayout.front),
      back: cardSpec(idForm.back, idLayout.back)
    }, { responseType: 'blob' });
    if (mode.value !== 'idcard') return;
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
  } catch (_) { /* 预览失败不打断 */ }
}

// 文字速印预览：调 /print/text/preview 现排现取图。输入时防抖，避免每敲一个字就打一次接口。
let textPrevTimer = null;
async function refreshTextPreview() {
  if (mode.value !== 'text') return;
  if (!textForm.body.trim()) return;
  try {
    const blob = await api.post('/print/text/preview', {
      title: textForm.title, body: textForm.body, media: opt.media,
      fontSize: textForm.fontSize, lineGap: textForm.lineGap, margin: textForm.margin
    }, { responseType: 'blob' });
    if (mode.value !== 'text') return;
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
  } catch (_) { /* 预览失败不打断输入 */ }
}

watch([mode, () => current.value?.id, () => images.value.length,
  () => idForm.front?.id, () => idForm.back?.id], () => { refreshPreview(); });

// 文字内容/排版参数变化时刷新预览（停止输入 600ms 后才请求）
watch([() => textForm.body, () => textForm.title, () => textForm.fontSize,
  () => textForm.lineGap, () => textForm.margin, () => opt.media], () => {
  if (mode.value !== 'text') return;
  clearTimeout(textPrevTimer);
  textPrevTimer = setTimeout(refreshTextPreview, 600);
});

// 身份证旋转/缩放变化时实时重排预览（防抖，避免拖动滑杆时高频请求）
let idPrevTimer = null;
watch([() => idLayout.front.rotate, () => idLayout.front.scale,
  () => idLayout.back.rotate, () => idLayout.back.scale, () => opt.media], () => {
  if (mode.value !== 'idcard') return;
  clearTimeout(idPrevTimer);
  idPrevTimer = setTimeout(refreshIdcardPreview, 250);
});

function pickFile(f) { current.value = f; }
function clearCurrent() { current.value = null; }

async function removeFile(f) {
  try {
    await api.delete(`/files/${f.id}`);
    if (current.value?.id === f.id) current.value = null;
    await load();
    message.success('已删除');
  } catch (e) { message.error(e.message); }
}

function onModeChange() {
  // 不同模式的内容互不干扰，切回来时保持各自选择
  previewUrl.value = '';
  refreshPreview();
}

function switchMode(key) {
  if (mode.value === key) return;
  mode.value = key;
  onModeChange();
}

function baseOptions() {
  const extra = extraText.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { ...opt, extra };
}

async function submit() {
  if (!canSubmit.value) return;
  // 队列停用/拒收时，任务会一直挂在 CUPS 里不会真出纸，提交前先挡住
  const target = printers.value.find((x) => x.name === opt.printer);
  if (target && (target.enabled === false || target.accepting === false || target.state === 'stopped')) {
    message.warning(`「${target.name}」当前已停用或不接收任务，请换一台打印机`);
    return;
  }
  submitting.value = true;
  try {
    let d;
    if (mode.value === 'standard') {
      d = await api.post('/print', { fileId: current.value.id, printer: opt.printer, options: baseOptions() });
    } else if (mode.value === 'text') {
      d = await api.post('/print/text', {
        title: textForm.title, body: textForm.body, media: opt.media,
        fontSize: textForm.fontSize, lineGap: textForm.lineGap, margin: textForm.margin,
        printer: opt.printer, options: baseOptions()
      });
    } else if (mode.value === 'invoice') {
      d = await api.post('/print/compose', {
        fileIds: images.value.map((x) => x.id), layout: 'grid', perPage: invForm.perPage,
        media: opt.media, title: '发票合排', printer: opt.printer, options: baseOptions()
      });
    } else {
      d = await api.post('/print/idcard', {
        media: opt.media, printer: opt.printer, options: baseOptions(),
        front: cardSpec(idForm.front, idLayout.front),
        back: cardSpec(idForm.back, idLayout.back)
      });
    }
    message.success(d.msg || '已提交');
    await Promise.all([loadTasks(), load()]);
  } catch (e) {
    message.error(e.message);
  } finally {
    submitting.value = false;
  }
}

const onRefresh = () => { load(); loadTasks(); };
let taskTimer = null;
// ---------- 参数记忆 ----------
// 同一类单据往往反复打，份数/单双面/纸张每次都重设很烦。
// 只记「稳定的偏好」，页码范围、水印、自定义参数这类一次性内容不记，避免下次误带。
const PREF_KEY = 'pg_print_prefs';
const PREF_FIELDS = {
  copies: (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, 1), 99) : 1; },
  color: (v) => (v === 'color' ? 'color' : 'mono'),
  sides: (v) => (['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'].includes(v) ? v : 'one-sided'),
  media: (v) => (MEDIA_MM[String(v)] ? String(v) : 'A4'),
  scaling: (v) => (['auto', 'fit', 'fill', 'none'].includes(v) ? v : 'fit'),
  numberUp: (v) => ([1, 2, 4, 6, 9].includes(+v) ? +v : 1),
  pageSet: (v) => (['all', 'odd', 'even', 'even-reverse'].includes(v) ? v : 'all'),
  mirror: (v) => !!v,
  mediaType: (v) => (typeof v === 'string' && v ? v : null),
  inputSlot: (v) => (typeof v === 'string' && v ? v : null),
  resolution: (v) => (typeof v === 'string' && v ? v : null)
};
const PREF_DEFAULTS = {
  copies: 1, color: 'mono', sides: 'one-sided', media: 'A4', scaling: 'fit',
  numberUp: 1, pageSet: 'all', mirror: false, mediaType: null, inputSlot: null, resolution: null
};

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    for (const [k, coerce] of Object.entries(PREF_FIELDS)) {
      if (k in raw) opt[k] = coerce(raw[k]);
    }
  } catch (_) { /* 存坏了就用默认值 */ }
}

function savePrefs() {
  try {
    const out = {};
    for (const k of Object.keys(PREF_FIELDS)) out[k] = opt[k];
    localStorage.setItem(PREF_KEY, JSON.stringify(out));
  } catch (_) { /* 隐私模式写不进去，忽略 */ }
}

function resetPrefs() {
  Object.assign(opt, PREF_DEFAULTS);
  savePrefs();
  message.success('已恢复默认参数');
}

// 改动频繁（改份数会连点），防抖后再落盘
let prefTimer = null;
watch(opt, () => {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(savePrefs, 400);
}, { deep: true });

onMounted(() => {
  loadPrefs();
  load();
  loadTasks();
  window.addEventListener('pg:refresh', onRefresh);
  taskTimer = setInterval(loadTasks, 20000);
});
onBeforeUnmount(() => {
  window.removeEventListener('pg:refresh', onRefresh);
  if (taskTimer) clearInterval(taskTimer);
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
});
</script>

<style scoped>
.pv-pagebar { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 6px; }
.pv-pageno { font-size: 12px; color: #6b7280; }
</style>
<style scoped>
/* 普通用户直接访问本页（不在管理台布局里），补上外边距 */
.page.standalone { max-width: 1240px; margin: 0 auto; padding: 22px 24px 48px; }
.print-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; margin-bottom: 14px;
  background: #fff; border: 1px solid var(--pg-border); border-radius: 14px;
}
.bar-label { font-size: 13px; font-weight: 600; color: #334155; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.col { display: grid; gap: 14px; min-width: 0; }
.block { border-radius: 14px; }
.mode-tabs {
  display: flex; gap: 2px; margin-bottom: 14px;
  background: #fff; border: 1px solid var(--pg-border); border-radius: 12px; padding: 4px;
}
.mt-item {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 6px; border: 0; background: transparent; border-radius: 9px;
  font-size: 13px; color: #64748b; cursor: pointer; transition: all .16s ease; white-space: nowrap;
}
.mt-item:hover { color: #0f766e; background: #f0fdfa; }
.mt-item.on { background: #ecfdf5; color: #0f766e; font-weight: 600; box-shadow: inset 0 0 0 1px #99f6e4; }

.drop { padding: 26px 12px; text-align: center; }
.drop-title { font-size: 14px; font-weight: 600; margin: 10px 0 4px; }

.picked {
  margin-top: 14px; padding: 12px; border: 1px solid #ccfbf1; background: #f0fdfa;
  border-radius: 12px; display: flex; align-items: center; gap: 10px;
}
.picked-name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.filelist { display: grid; gap: 6px; max-height: 240px; overflow-y: auto; }
.fileitem {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border: 1px solid var(--pg-border); border-radius: 10px; cursor: pointer;
}
.fileitem:hover { background: #f8fafc; }
.fileitem.active { border-color: #5eead4; background: #f0fdfa; }
.fi-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.field-label { font-size: 12.5px; font-weight: 600; color: #475569; margin-bottom: 7px; }

.seg { display: flex; gap: 8px; }
.seg-item {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 10px; font-size: 13px; cursor: pointer;
  border: 1px solid #e2e8f0; background: #fff; border-radius: 10px; color: #475569;
  transition: all .16s ease;
}
.seg-item:hover { border-color: #99f6e4; color: #0f766e; }
.seg-item.on { background: #ecfdf5; border-color: #0ea5a4; color: #0f766e; font-weight: 600;
  box-shadow: inset 0 0 0 1px rgba(14, 165, 164, .35); }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 10px; }
.subset :deep(.n-radio-button) { font-size: 12.5px; }

.thumbs { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.thumb {
  position: relative; width: 92px; height: 92px; border-radius: 10px; overflow: hidden;
  border: 1px solid var(--pg-border); background: #f8fafc;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb-idx {
  position: absolute; left: 5px; top: 5px; background: rgba(15, 23, 42, .62); color: #fff;
  font-size: 11px; padding: 1px 6px; border-radius: 6px;
}
.thumb-del { position: absolute; right: 3px; top: 3px; background: rgba(255, 255, 255, .88) !important; }

.idcard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.idcard-slot {
  height: 132px; border: 1px dashed #cbd5e1; border-radius: 12px; background: #f8fafc;
  display: grid; place-items: center; align-content: center; gap: 4px; cursor: pointer;
  overflow: hidden; transition: border-color .16s ease;
}
.idcard-slot:hover { border-color: #5eead4; }
.idcard-slot img { width: 100%; height: 100%; object-fit: contain; background: #fff; }
.slot-title { font-size: 12.5px; font-weight: 600; color: #64748b; }

.id-layout { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.id-layout-row { display: flex; align-items: center; gap: 10px; }
.id-layout-label { width: 48px; font-size: 12.5px; color: #64748b; flex: 0 0 48px; }

.preview {
  min-height: 260px; border-radius: 12px; background: #f8fafc; border: 1px solid #eef2f7;
  display: grid; place-items: center; padding: 12px; overflow: hidden;
}
.preview img {
  max-width: 100%; max-height: 470px; border-radius: 6px;
  box-shadow: 0 8px 26px rgba(15, 23, 42, .1);
  transition: transform .22s ease;
}
/* 选「横向」时把预览一起转过来，让方向切换有可见反馈（打印时页面就是横向的） */
.preview img.rotated { transform: rotate(-90deg); }
.preview-empty { text-align: center; padding: 26px 10px; }

.orient { display: inline-flex; background: #f1f5f9; border-radius: 8px; padding: 2px; }
.og {
  border: 0; background: transparent; font-size: 11.5px; padding: 3px 9px;
  border-radius: 6px; color: #64748b; cursor: pointer;
}
.og.on { background: #fff; color: #0f766e; font-weight: 600; box-shadow: 0 1px 3px rgba(15, 23, 42, .1); }

.rec-list { display: grid; gap: 8px; }
.rec { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--pg-border); border-radius: 10px; }
.rec:hover { background: #f8fafc; }
.rec-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-meta { font-size: 11.5px; margin-top: 2px; }

.stat-row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; font-size: 12.5px; }
.stat-k { color: #64748b; }
.stat-v { font-weight: 600; color: #0f172a; }
.markers { display: grid; gap: 10px; }
.marker-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.marker-name { font-size: 12px; color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 78%; }

@media (max-width: 1080px) {
  .layout { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
  .grid2, .grid3, .idcard-grid { grid-template-columns: 1fr; }
  .print-bar { flex-direction: column; align-items: stretch; }
  .mode-tabs { flex-wrap: wrap; }
  .mt-item { flex: 1 1 calc(50% - 2px); }
}
</style>
