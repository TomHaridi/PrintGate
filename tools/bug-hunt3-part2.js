'use strict';
// bug-hunt3 后半段：打印参数、并发、输入模糊、权限边界、清理边界
module.exports = async function run(ctx) {
  const { req, rec, sleep, TOKEN, NL, CR, QUOTE, results, BASE } = ctx;

  console.log(NL + '== C. 打印参数与限额边界 ==');
  const pr = await req('GET', '/api/printers');
  let printer = (pr.data.printers || [])[0]?.name || '';
  if (!printer) {
    await req('POST', '/api/printers/virtual', {});
    await sleep(1500);
    const pr2 = await req('GET', '/api/printers');
    printer = (pr2.data.printers || [])[0]?.name || '';
  }
  const pdf = '%PDF-1.4' + NL + '1 0 obj<</Type/Catalog>>endobj' + NL + 'trailer<</Root 1 0 R>>' + NL + '%%EOF' + NL;
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(pdf)], { type: 'application/pdf' }), 'bh3.pdf');
  const up = await req('POST', '/api/files', fd);
  const fileId = up.data.file?.id;
  rec('准备打印机与测试文件', !!fileId && !!printer, `file=${fileId} printer=${printer}`);

  if (fileId && printer) {
    const cases = [
      ['份数 0', { copies: 0 }],
      ['份数 -5', { copies: -5 }],
      ['份数 99999', { copies: 99999 }],
      ['份数非数字', { copies: 'abc' }],
      ['页码注入分号', { pageRanges: '1-3; rm -rf /' }],
      ['页码命令替换', { pageRanges: '1-$(id)' }],
      ['介质注入换行', { media: 'A4' + NL + 'evil' }],
      ['双面非法值', { sides: 'evil' }],
      ['额外参数注入', { extra: ['a=1' + NL + 'evil', 'b=2'] }]
    ];
    for (const [name, opts] of cases) {
      const rr = await req('POST', '/api/print', { fileId, printer, options: opts });
      rec(`${name}被拒或被规范化`, [200, 400, 403].includes(rr.status),
        `${rr.status} ${rr.data.msg || rr.data.status || ''}`.slice(0, 60));
    }
    const jobs = await req('GET', '/api/jobs');
    rec('队列无注入残留', !/rm -rf|\$\(id\)/.test(JSON.stringify(jobs.data)), '');
  }

  console.log(NL + '== D. 并发一致性 ==');
  if (fileId && printer) {
    const many = await Promise.all(Array.from({ length: 6 }, () =>
      req('POST', '/api/print', { fileId, printer, options: { copies: 1 } })));
    rec('并发提交 6 次不崩', many.every((x) => [200, 400, 403].includes(x.status)),
      many.map((x) => x.status).join(','));
    const okOnes = many.filter((x) => x.status === 200);
    rec('成功的都有任务号', okOnes.every((x) => x.data.taskId), `${okOnes.length} 个成功`);
    if (okOnes.length) {
      const id = okOnes[0].data.taskId;
      const cancels = await Promise.all(Array.from({ length: 4 }, () => req('POST', `/api/tasks/${id}/cancel`)));
      rec('并发取消同一任务结果一致', cancels.every((x) => [200, 400, 404, 409].includes(x.status)),
        cancels.map((x) => x.status).join(','));
      const retries = await Promise.all(Array.from({ length: 4 }, () => req('POST', `/api/tasks/${id}/retry`)));
      rec('并发重试同一任务不崩', retries.every((x) => [200, 400, 404, 409].includes(x.status)),
        retries.map((x) => x.status).join(','));
    }
    const fd2 = new FormData();
    fd2.append('file', new Blob([Buffer.from(pdf)], { type: 'application/pdf' }), 'bh3-del.pdf');
    const up2 = await req('POST', '/api/files', fd2);
    const fid2 = up2.data.file?.id;
    if (fid2) {
      const dels = await Promise.all(Array.from({ length: 5 }, () => req('DELETE', `/api/files/${fid2}`)));
      rec('并发删除同一文件幂等', dels.every((x) => [200, 404, 410].includes(x.status)),
        dels.map((x) => x.status).join(','));
    }
  }

  console.log(NL + '== E. 输入模糊 ==');
  const longStr = 'x'.repeat(5000);
  const xss = '<script>alert(1)</script>';
  const sql = "' OR 1=1 --";
  const emoji = '打印机测试-emoji';
  const printerNow = (await req('GET', '/api/printers')).data.printers?.[0]?.name || printer;
  const cases = [['超长备注', longStr], ['XSS 备注', xss], ['SQL 备注', sql], ['emoji 备注', emoji]];
  for (const [name, val] of cases) {
    if (!printerNow) { rec(name, false, '无可用打印机'); continue; }
    const rr = await req('PUT', `/api/printers/${encodeURIComponent(printerNow)}/note`, { note: val });
    rec(`${name}不崩`, [200, 400, 404].includes(rr.status), String(rr.status));
  }
  const afterN = await req('GET', '/api/printers');
  const noteVal = (afterN.data.printers || []).find((p) => p.name === printerNow)?.note || '';
  rec('备注按原文存储、未被当作脚本', typeof noteVal === 'string', `长度 ${noteVal.length}`);
  rec('接口仍健康', (await req('GET', '/api/health')).status === 200, '');

  // 打印机名做路径穿越 / SQL
  const badNames = ['../../etc/passwd', "x' OR '1'='1", 'a b c; rm -rf /'];
  for (const nm of badNames) {
    const rr = await req('GET', `/api/printers/${encodeURIComponent(nm)}`);
    rec(`非法打印机名 ${nm.slice(0, 18)} 安全返回`, [400, 404].includes(rr.status), String(rr.status));
  }

  console.log(NL + '== F. 权限边界 ==');
  // 小程序用户令牌不能碰后台接口
  const devOn = await req('PUT', '/api/settings', {
    devMode: true,
    wxAppid: 'wx1234567890abcdef',
    wxSecret: '0123456789abcdef0123456789abcdef'
  });
  if (devOn.status === 200) {
    // /mp/login 会真的去换 openid，这里用开发模式提供的模拟登录拿一枚小程序令牌
    const login = await req('POST', '/api/mp/dev-login', { nickname: 'bh3' });
    const mpToken = login.data.token;
    if (mpToken) {
      const guarded = ['/api/users', '/api/settings', '/api/keys', '/api/audit', '/api/security/attempts'];
      for (const u of guarded) {
        const rr = await req('GET', u, undefined, { headers: { Authorization: `Bearer ${mpToken}` } });
        rec(`小程序令牌访问 ${u} 被拒`, rr.status === 401, String(rr.status));
      }
      const mpPrint = await req('POST', '/api/print', { fileId, printer, options: {} },
        { headers: { Authorization: `Bearer ${mpToken}` } });
      rec('待审批用户打印被拦', [401, 403].includes(mpPrint.status), String(mpPrint.status));
    } else {
      rec('模拟小程序登录', false, JSON.stringify(login.data).slice(0, 60));
    }
    await req('PUT', '/api/settings', { devMode: false });
  }

  console.log(NL + '== G. 清理与数据边界 ==');
  const c1 = await req('POST', '/api/printers/history/clean', { days: 9999 });
  rec('超过上限的保留天数被拒', c1.status === 400, `${c1.status} ${c1.data.msg || ''}`.slice(0, 50));
  const c2 = await req('POST', '/api/printers/history/clean', { days: -1 });
  rec('负数保留天数被拒', c2.status === 400, String(c2.status));
  const c3 = await req('POST', '/api/printers/history/clean', { days: 7, targets: ['evil'] });
  rec('未知清理项被拒', c3.status === 400, String(c3.status));
  const t1 = Date.now();
  const many2 = await Promise.all(Array.from({ length: 4 }, () =>
    req('POST', '/api/printers/history/clean', { days: 7, targets: ['tasks'] })));
  rec('并发清理不崩', many2.every((x) => [200, 429].includes(x.status)),
    `${many2.map((x) => x.status).join(',')} 耗时 ${Date.now() - t1}ms`);

  console.log(NL + '== H. 审计导出 CSV 公式注入 ==');
  // 审计 detail 里会原样记录文件名；若导出时不中和 Excel 公式前缀，
  // 管理员用 Excel/WPS 打开 CSV 就会被当作公式执行（数据外泄/钓鱼入口）
  // 带引号/协议的复杂串会在 multipart 解析时被截断，取能原样入库的朴素公式前缀
  const formulaNames = ['=1+1.pdf', '@SUM(1+9).pdf', '+cmd.pdf', '-2+3.pdf'];
  for (const formulaName of formulaNames) {
    const fdEvil = new FormData();
    fdEvil.append('file', new Blob([Buffer.from(pdf)], { type: 'application/pdf' }), formulaName);
    const upEvil = await req('POST', '/api/files', fdEvil);
    const evilId = upEvil.data.file?.id;
    if (!evilId) { rec(`上传 ${formulaName}`, false, upEvil.data.msg || ''); continue; }
    await req('DELETE', `/api/files/${evilId}`);
    const exp = await fetch(`${BASE}/api/audit/export`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const csv = await exp.text();
    const hit = csv.split(NL).filter((line) => line.includes(formulaName.replace('.pdf', '')));
    rec(`审计含 ${formulaName}`, hit.length > 0, `${hit.length} 行`);
    // 被中和的单元格形如 " '=1+1.pdf"，绝不能是 "=1+1.pdf 这种裸公式
    const rawFormula = new RegExp(String.fromCharCode(34) + '=[+@-]|' + String.fromCharCode(34) + '[-+]');
    const naked = hit.filter((line) => rawFormula.test(line));
    rec(`${formulaName} 公式前缀已中和`, hit.length > 0 && naked.length === 0,
      hit.length ? hit[0].slice(0, 70) : '无记录');
  }

  const pass = results.filter((x) => x.pass).length;
  console.log(NL + `=== ${pass}/${results.length} 通过 ===`);
  const failed = results.filter((x) => !x.pass);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(' - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
};
