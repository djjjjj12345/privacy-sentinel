/* ============================================================
 *  i18n.js  —  极简双语（zh / en）
 *
 *  用法：
 *    1. HTML：<button data-i18n="nav.history">预警历史</button>
 *             <input data-i18n-placeholder="input.placeholder" placeholder="..." />
 *             <title data-i18n-title="title.app">...</title>
 *    2. JS：   i18n.t('toast.saved')  //  → "已保存" / "Saved"
 *    3. 切换：i18n.setLocale('en')  //  触发整页重译
 * ============================================================ */
(function (global) {
  'use strict';

  const MESSAGES = {
    zh: {
      'app.title': '隐私哨兵 - 敏感信息检测',
      'app.brand': '🛡️ 隐私哨兵',
      'nav.guide': '防骗指南',
      'nav.history': '预警历史',
      'nav.settings': '设置',
      'nav.lang': '中/EN',
      'input.placeholder': '输入消息或图片URL...',
      'input.send': '发送',
      'settings.title': '⚙️ 设置',
      'settings.profile': '用户画像',
      'settings.age': '年龄段',
      'settings.age.youth': '青少年（13-25）',
      'settings.age.adult': '青壮年（26-59）',
      'settings.age.elder': '老年（60+）',
      'settings.literacy': '数字素养',
      'settings.literacy.basic': '基础',
      'settings.literacy.intermediate': '中等',
      'settings.literacy.advanced': '熟练',
      'settings.sensitivity': '风险灵敏度',
      'settings.sensitivity.low': '保守（少弹窗）',
      'settings.sensitivity.medium': '标准',
      'settings.sensitivity.high': '激进（多弹窗）',
      'settings.contacts': '紧急联系人',
      'settings.addContact': '+ 添加紧急联系人',
      'settings.reset': '↺ 恢复默认设置',
      'history.title': '📋 预警历史',
      'history.empty': '暂无预警记录',
      'history.clear': '清空',
      'history.cleared': '已清空预警历史',
      'guide.title': '📖 防骗指南',
      'risk.title': '⚠️ 敏感信息检测',
      'risk.subtitle': '检测到 {labels}',
      'risk.l3.title': '🚨 高风险预警',
      'risk.l3.subtitle': '发送已暂停',
      'risk.l4.title': '⛔ 发送已阻止',
      'risk.l4.subtitle': '极高风险 · 强制阻断',
      'risk.cancel': '取消',
      'risk.confirm': '仍然发送（已脱敏）',
      'risk.l3.confirm': '继续发送 (8s)',
      'risk.l4.ack': '我知道了',
      'risk.l4.guide': '📖 查看防骗指南',
      'risk.suggestion': '💡 建议：',
      'risk.l1.toast': '🟢 {level} · {reason}',
      'risk.l1.message': '📋 检测到 {labels}，已自动脱敏。',
      'risk.l4.message': '🚫 检测到 {labels} 正在被发送出去。',
      'risk.l4.otpwarn': '验证码泄露将直接导致账户被盗！',
      'risk.l4.contact': '📞 已建议通知紧急联系人',
      'toast.faceBlur.on': '已自动模糊 {n} 张人脸',
      'toast.faceBlur.unsupported': '当前浏览器不支持 FaceDetector，已改为中央区域模糊',
      'toast.faceBlur.off': '已关闭人脸模糊（不推荐）',
      'toast.fileTooLarge': '文件过大（{n}MB），超过 25MB 上限。请先压缩。',
      'toast.unsupportedImage': '目前只支持图片格式，请重新选择。',
      'toast.unsupportedAudio': '不支持的音频格式（{mime}）。请使用 MP3 / WAV / AAC / M4A。',
      'toast.unsupportedVideo': '不支持的视频格式（{mime}）。豆包只接受 MP4 容器。',
      'toast.unknownKind': '未知文件类型：{kind}',
      'toast.truncated': '消息过长，AI 仅对前 12000 字做了复检',
      'boot.hint1': '🔍 试试发送 "我的身份证是110105199003071239" 或 "卡号6228480012345671"',
      'boot.hint2': '📷 点击左下角 📎 上传一张身份证 / 银行卡照片，体验真正的多模态识别',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'error.network': '网络异常，请重试',
      'error.timeout': '识别超时，请检查网络后重试',
      'nav.account': '账号',
      'auth.title': '👤 登录',
      'auth.sub': '登录后预警历史将云端同步，换设备也不丢',
      'auth.login': '登录',
      'auth.register': '注册',
      'auth.username': '用户名（2-24 位字母/数字/中文）',
      'auth.password': '密码（至少 6 位）',
      'auth.close': '取消',
      'auth.privacyNote': '🔒 密码仅以 scrypt 哈希存储；账号仅用于同步你的预警历史，不收集任何其他信息。',
      'auth.err.empty': '请输入用户名和密码',
      'auth.err.failed': '操作失败，请重试',
      'auth.welcome': '✅ 已登录：{name}',
      'auth.bye': '已退出登录',
      'account.title': '👤 我的账号',
      'account.sub': '云端同步已开启',
      'account.synced': '已同步预警记录',
      'account.close': '关闭',
      'account.logout': '退出登录',
      'history.export': '导出 JSON 备份',
      'history.import': '导入 JSON 备份',
      'history.exported': '✅ 备份已下载',
      'history.imported': '✅ 已导入 {n} 条记录',
      'history.importBad': '文件格式不正确，请选择隐私哨兵导出的 JSON 备份',
      'report.title': '隐私哨兵 · 检测报告',
      'report.button': '导出报告',
      'report.level': '风险等级',
      'report.target': '检测对象',
      'report.engine': '检测引擎',
      'report.action': '处置方式',
      'report.items': '敏感信息条目',
      'report.typeCol': '类型',
      'report.valueCol': '内容（已脱敏）',
      'report.levelCol': '等级',
      'report.reason': '判定依据',
      'report.advice': '处置建议',
      'report.transcript': '转写节选',
      'report.footer': '本报告由隐私哨兵自动生成。原始内容不出本机，云端 AI 仅接触脱敏/降采样后的数据。',
    },
    en: {
      'app.title': 'Privacy Sentinel - Sensitive Info Detection',
      'app.brand': '🛡️ Privacy Sentinel',
      'nav.guide': 'Guide',
      'nav.history': 'History',
      'nav.settings': 'Settings',
      'nav.lang': '中/EN',
      'input.placeholder': 'Type a message or image URL...',
      'input.send': 'Send',
      'settings.title': '⚙️ Settings',
      'settings.profile': 'User Profile',
      'settings.age': 'Age group',
      'settings.age.youth': 'Youth (13-25)',
      'settings.age.adult': 'Adult (26-59)',
      'settings.age.elder': 'Senior (60+)',
      'settings.literacy': 'Digital literacy',
      'settings.literacy.basic': 'Basic',
      'settings.literacy.intermediate': 'Intermediate',
      'settings.literacy.advanced': 'Advanced',
      'settings.sensitivity': 'Risk sensitivity',
      'settings.sensitivity.low': 'Low (fewer popups)',
      'settings.sensitivity.medium': 'Standard',
      'settings.sensitivity.high': 'High (more popups)',
      'settings.contacts': 'Emergency contacts',
      'settings.addContact': '+ Add emergency contact',
      'settings.reset': '↺ Reset to defaults',
      'history.title': '📋 Alert History',
      'history.empty': 'No alerts yet',
      'history.clear': 'Clear',
      'history.cleared': 'Alert history cleared',
      'guide.title': '📖 Anti-Fraud Guide',
      'risk.title': '⚠️ Sensitive Information Detected',
      'risk.subtitle': 'Detected: {labels}',
      'risk.l3.title': '🚨 High Risk Alert',
      'risk.l3.subtitle': 'Sending paused',
      'risk.l4.title': '⛔ Sending Blocked',
      'risk.l4.subtitle': 'Critical risk · Forced block',
      'risk.cancel': 'Cancel',
      'risk.confirm': 'Send anyway (masked)',
      'risk.l3.confirm': 'Send anyway (8s)',
      'risk.l4.ack': 'Got it',
      'risk.l4.guide': '📖 View anti-fraud guide',
      'risk.suggestion': '💡 Suggestion:',
      'risk.l1.toast': '🟢 {level} · {reason}',
      'risk.l1.message': '📋 Detected {labels}, auto-masked.',
      'risk.l4.message': '🚫 Detected {labels} about to be sent out.',
      'risk.l4.otpwarn': 'OTP leak will directly lead to account theft!',
      'risk.l4.contact': '📞 Emergency contacts have been notified',
      'toast.faceBlur.on': 'Auto-blurred {n} face(s)',
      'toast.faceBlur.unsupported': 'FaceDetector not supported, falling back to center-blur',
      'toast.faceBlur.off': 'Face blur disabled (not recommended)',
      'toast.fileTooLarge': 'File too large ({n}MB), exceeds 25MB. Please compress first.',
      'toast.unsupportedImage': 'Only image formats are supported.',
      'toast.unsupportedAudio': 'Unsupported audio format ({mime}). Use MP3 / WAV / AAC / M4A.',
      'toast.unsupportedVideo': 'Unsupported video format ({mime}). Doubao only accepts MP4 container.',
      'toast.unknownKind': 'Unknown file kind: {kind}',
      'toast.truncated': 'Message too long; AI only checked the first 12000 chars',
      'boot.hint1': '🔍 Try sending "My ID is 110105199003071239" or "card 6228480012345671"',
      'boot.hint2': '📷 Click 📎 (bottom-left) to upload an ID/card photo for real multi-modal detection',
      'time.justNow': 'just now',
      'time.minutesAgo': '{n} min ago',
      'error.network': 'Network error, please retry',
      'error.timeout': 'Detection timeout, please check your network and retry',
      'nav.account': 'Account',
      'auth.title': '👤 Sign in',
      'auth.sub': 'Sign in to sync your alert history across devices',
      'auth.login': 'Sign in',
      'auth.register': 'Sign up',
      'auth.username': 'Username (2-24 letters/digits/Chinese)',
      'auth.password': 'Password (at least 6 chars)',
      'auth.close': 'Cancel',
      'auth.privacyNote': '🔒 Passwords are stored as scrypt hashes only. The account is used solely to sync your alert history.',
      'auth.err.empty': 'Please enter username and password',
      'auth.err.failed': 'Operation failed, please retry',
      'auth.welcome': '✅ Signed in: {name}',
      'auth.bye': 'Signed out',
      'account.title': '👤 My Account',
      'account.sub': 'Cloud sync enabled',
      'account.synced': 'Alert records synced',
      'account.close': 'Close',
      'account.logout': 'Sign out',
      'history.export': 'Export JSON backup',
      'history.import': 'Import JSON backup',
      'history.exported': '✅ Backup downloaded',
      'history.imported': '✅ Imported {n} records',
      'history.importBad': 'Invalid file. Please choose a JSON backup exported by Privacy Sentinel',
      'report.title': 'Privacy Sentinel · Detection Report',
      'report.button': 'Export report',
      'report.level': 'Risk level',
      'report.target': 'Target',
      'report.engine': 'Engine',
      'report.action': 'Action taken',
      'report.items': 'Detected sensitive items',
      'report.typeCol': 'Type',
      'report.valueCol': 'Content (masked)',
      'report.levelCol': 'Level',
      'report.reason': 'Reasoning',
      'report.advice': 'Recommendation',
      'report.transcript': 'Transcript excerpt',
      'report.footer': 'This report was generated automatically by Privacy Sentinel. Raw content never leaves your device; the cloud AI only sees masked/downsampled data.',
    },
  };

  const STORAGE_KEY = 'privacySentinel.locale';
  const SUPPORTED = ['zh', 'en'];
  const DEFAULT_LOCALE = 'zh';

  let current = loadLocale();

  function loadLocale() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.includes(stored)) return stored;
      // 跟随浏览器语言
      const browser = (navigator.language || 'zh').toLowerCase();
      if (browser.startsWith('en')) return 'en';
    } catch (e) {}
    return DEFAULT_LOCALE;
  }

  function getLocale() { return current; }

  function setLocale(locale) {
    if (!SUPPORTED.includes(locale)) return;
    current = locale;
    try { localStorage.setItem(STORAGE_KEY, locale); } catch (e) {}
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    applyToDOM();
    // 通知监听器（让 JS 端能更新动态文本）
    document.dispatchEvent(new CustomEvent('localechange', { detail: { locale } }));
  }

  /** 翻译键，支持 {var} 占位符 */
  function t(key, params) {
    const dict = MESSAGES[current] || MESSAGES[DEFAULT_LOCALE];
    let s = dict[key] || MESSAGES[DEFAULT_LOCALE][key] || key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : ''));
    }
    return s;
  }

  /** 扫描 DOM 替换 data-i18n 标签 */
  function applyToDOM(root) {
    const scope = root || document;
    // text
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    });
    // placeholder
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.setAttribute('placeholder', t(key));
    });
    // title
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      el.setAttribute('title', t(key));
    });
    // aria-label
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      el.setAttribute('aria-label', t(key));
    });
    // <html lang>
    document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  }

  // 暴露
  global.i18n = { t, setLocale, getLocale, applyToDOM, SUPPORTED };
  // DOM ready 后自动翻译一次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyToDOM());
  } else {
    setTimeout(() => applyToDOM(), 0);
  }
})(window);
