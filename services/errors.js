/**
 * 统一错误分类
 * ---------------------------------------------------------------
 * 目标：用户看到的每一条报错都要能回答三个问题——
 *   ① 出了什么事？ ② 是不是我的问题？ ③ 我下一步该做什么？
 *
 * 因此每个错误都带 title（一句话）、message（说明）、action（可执行动作）、
 * retryable（是否值得重试）。后端只返回 code，前端据此渲染中文文案。
 *
 * 另外一个现实问题：部署在 Render / 免费容器上时，实例休眠后首个请求会
 * 拿到 502/503，用户看到原生错误页会以为服务坏了。这类错误单独归类为
 * service_waking，明确告诉用户「等 15~30 秒再来」，而不是「服务异常」。
 */

/** 错误目录：code -> 定义 */
const CATALOG = {
  empty_input: {
    http: 400,
    title: '没有可检测的内容',
    message: '你提交的内容是空的，或只包含空格和换行。',
    action: '输入一段文字，或上传图片 / 音频 / 视频后再检测。',
    retryable: false,
  },
  invalid_kind: {
    http: 400,
    title: '不支持的内容类型',
    message: '当前支持文本、图片、音频、视频四种检测对象。',
    action: '请确认提交的是上述类型之一。',
    retryable: false,
  },
  invalid_format: {
    http: 400,
    title: '内容格式不对',
    message: '提交的内容无法解析，可能是文件损坏、编码异常，或不是有效的媒体文件。',
    action: '换一个文件试试；图片建议用 JPG / PNG，音频建议用 MP3 / WAV。',
    retryable: false,
  },
  invalid_url: {
    http: 400,
    title: '图片地址不可用',
    message: '只接受 http / https 公网图片地址，且不能指向内网或本机服务。',
    action: '换一个公网图片链接，或直接把图片文件拖进输入框（本地图片不上传服务器）。',
    retryable: false,
  },
  payload_too_large: {
    http: 413,
    title: '内容太大了',
    message: '单次提交的大小超出上限。',
    action: '压缩图片（长边 1600px 以内即可），或把音视频剪到 1 分钟以内再上传。',
    retryable: false,
  },
  unsupported_media: {
    http: 415,
    title: '这个文件格式不支持',
    message: '上传的音频或视频格式不在支持范围内。',
    action: '音频请用 MP3 / WAV / AAC / M4A，视频请用 MP4 / MOV，或先转成这些格式再试。',
    retryable: false,
  },
  apikey_invalid: {
    http: 401,
    title: '识别服务的 API Key 无效',
    message: '调用识别服务时被拒绝，通常是服务端密钥未配置、填错或已失效。',
    action: '这是服务端配置问题：请检查部署环境变量中的 API Key 是否正确、是否还有额度。',
    retryable: false,
  },
  rate_limited: {
    http: 429,
    title: '操作太频繁了',
    message: '为保护服务不被刷爆，每分钟的请求次数有上限。',
    action: '稍等 30 秒后重试。如需批量检测，建议使用批量模式一次性提交。',
    retryable: true,
  },
  upstream_timeout: {
    http: 504,
    title: '识别服务响应超时',
    message: '已提交给识别引擎，但它在规定时间内没有返回结果。',
    action: '稍后重试。若持续超时，可先用「本地规则」模式，它不依赖任何外部服务。',
    retryable: true,
  },
  upstream_error: {
    http: 502,
    title: '识别服务暂时不可用',
    message: '上游 AI 服务返回了异常，可能是额度用尽、密钥失效或服务侧故障。',
    action: '稍后重试，或在设置里切换到「本地规则」模式（不依赖 AI，仍可检测号码类信息）。',
    retryable: true,
  },
  /**
   * 注意：这个分类只由**前端**使用。
   * 服务端不可能处于「唤醒中」——能对请求做出业务响应的实例一定是活的。
   * 502/503 在服务端语境下是上游故障（upstream_error），
   * 只有前端 fetch 拿到网关代答的 502/503 时，才说明实例在冷启动。
   * 因此 classify() 不映射 502/503 到本类，避免把模型解析失败误报成「等一会儿就好」。
   */
  service_waking: {
    http: 503,
    title: '服务正在唤醒',
    message: '服务部署在按需运行的实例上，长时间无人访问后会自动休眠，首次访问需要冷启动。',
    action: '请等待 15~30 秒后自动重试，或手动再点一次检测。',
    retryable: true,
    retryAfterMs: 15000,
  },
  network_error: {
    http: 502,
    title: '网络连接失败',
    message: '没有连上服务，可能是网络中断、代理拦截，或服务正在重启。',
    action: '检查网络后重试；若刚打开页面就报错，多半是服务在冷启动，等 15~30 秒再试。',
    retryable: true,
  },
  auth_required: {
    http: 401,
    title: '需要登录',
    message: '这个功能需要登录后才能使用。',
    action: '点击右上角头像登录或注册。仅用于同步历史记录，不收集其他信息。',
    retryable: false,
  },
  not_found: {
    http: 404,
    title: '接口不存在',
    message: '请求的接口地址已变更或不存在。',
    action: '刷新页面后重试。',
    retryable: false,
  },
  server_error: {
    http: 500,
    title: '服务内部错误',
    message: '服务在处理这个请求时出错了，这属于程序问题，不是你的操作问题。',
    action: '请稍后重试。如果反复出现，欢迎到 GitHub 提 issue 附上时间与内容类型。',
    retryable: true,
  },
};

const DEFAULT_CODE = 'server_error';

/**
 * 取错误定义（不存在时退回 server_error）。
 * @param {string} code
 * @returns {{code:string} & typeof CATALOG[string]}
 */
function get(code) {
  const key = CATALOG[code] ? code : DEFAULT_CODE;
  return Object.assign({ code: key }, CATALOG[key]);
}

/**
 * 把任意异常归类。识别顺序很重要：
 * 先按显式 code，再按 HTTP 状态，最后按消息关键字兜底。
 *
 * @param {Error|Object|string} err
 * @returns {{code:string, http:number, title:string, message:string, action:string, retryable:boolean}}
 */
function classify(err) {
  if (!err) return get(DEFAULT_CODE);

  // 1) 业务代码显式指定
  if (typeof err === 'string' && CATALOG[err]) return get(err);
  if (err.code && CATALOG[err.code]) return get(err.code);
  if (err.errorCode && CATALOG[err.errorCode]) return get(err.errorCode);

  const status = Number(err.status || err.statusCode || err.response?.status || 0);
  const msg = String(err.message || err.error_msg || err.error || '');

  // 2) HTTP 状态码
  if (status === 400) return get('invalid_format');
  if (status === 413) return get('payload_too_large');
  if (status === 415) return get('unsupported_media');
  if (status === 429) return get('rate_limited');
  // 401/403 在服务端语境下几乎都是上游 Key 的问题（我们自己的登录态
  // 由 auth 中间件直接返回，不走这里），因此归为密钥无效而不是「请登录」
  if (status === 401 || status === 403) return get('apikey_invalid');
  if (status === 404) return get('not_found');
  if (status === 504) return get('upstream_timeout');
  // 502/503 在服务端语境下是上游故障；「正在唤醒」只有前端能观察到，
  // 见 service_waking 的注释。这里不能归为唤醒，否则模型解析失败会被
  // 误报成「等一会儿就好」，用户会一直空等。
  if (status === 502 || status === 503) return get('upstream_error');

  // 3) 消息关键字
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout of \d+ms|超时/i.test(msg)) return get('upstream_timeout');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|socket hang up/i.test(msg)) {
    return get('network_error');
  }
  if (/entity\.too\.large|request entity too large|请求体过大/i.test(msg)) return get('payload_too_large');
  if (/Rate limit|Too Many Requests|操作太频繁/i.test(msg)) return get('rate_limited');
  if (/缺少文本内容|文本内容为空|缺少图片内容|缺少音频内容|缺少视频内容|不支持的内容类型/i.test(msg)) {
    return get('empty_input');
  }

  return get(DEFAULT_CODE);
}

/**
 * 生成给前端的错误响应体。
 *
 * 关键取舍：**分类给机器，文案给人**。
 * code 决定前端的行为分支（是否重试、是否显示唤醒倒计时）；
 * 而 title 优先采用业务抛出的原始消息——它通常比目录里的通用文案具体得多
 * （例如「音频格式不支持（audio/webm）。请使用 MP3 / WAV」比「格式不对」有用得多）。
 * 目录里的 message / action 负责补充「为什么」和「怎么办」。
 *
 * 同时保留 error 字段以保持旧前端兼容。
 */
function payload(err, fallbackMessage) {
  const c = classify(err);
  const raw = String((err && (err.message || err.error)) || fallbackMessage || '').trim();

  // 业务消息优先；过长时截断，避免把整段堆栈塞进响应
  const title = raw ? (raw.length > 200 ? `${raw.slice(0, 197)}...` : raw) : c.title;

  return {
    success: false,
    code: c.code,
    error: title,
    title,
    message: c.message,
    action: c.action,
    retryable: c.retryable,
    retryAfterMs: c.retryAfterMs || null,
    // 目录中的标准标题，前端想展示统一文案时可用
    category: c.title,
  };
}

module.exports = { CATALOG, get, classify, payload, DEFAULT_CODE };
