/**
 * 将底层英文网络/代理错误统一成可操作的中文说明。
 */

const PROXY_VPN_HINT =
  "请检查：① 代理 IP/端口/账号密码是否正确；② VPN/代理是否在线；③ 换一个节点后再试。";

/** 币安广场 OpenAPI 业务码 —— 必须优先于网络提示 */
const BINANCE_BIZ_MAP = [
  [
    /220003|API\s*key\s*(does\s*not\s*exist|not\s*found|invalid)/i,
    "币安广场 API Key 不存在（220003）：请到「账号管理」检查该账号 Key 是否填对，或到创作者中心重新创建后更新",
  ],
  [
    /220004|API\s*key\s*has\s*expired|API\s*key\s*expired|key\s*has\s*expired/i,
    "币安广场 API Key 已失效/过期（220004）：请到币安广场创作者中心重新创建 Key，并在「账号管理」里更新该账号",
  ],
  [
    /220009|daily\s*(post|publish).*(limit|exceed)/i,
    "今日发帖已达上限（220009）：该账号今日 OpenAPI 发帖次数已用完，请明天再试或换账号",
  ],
  [/20002|20022/, "内容含敏感词，请修改文案后重试"],
  [/20013/, "内容长度超限，请缩短正文后重试"],
];

const ERROR_MAP = [
  ...BINANCE_BIZ_MAP,
  [
    /Socket closed|socket closed|Socks5? .*closed|connection closed before|Closed before receiving/i,
    `代理连接已断开（Socket closed）。多半是当前 VPN/代理节点不稳定或被重置。${PROXY_VPN_HINT}`,
  ],
  [/Proxy connection timed out/i, `代理连接超时。${PROXY_VPN_HINT}`],
  [/Socks5? proxy rejected connection|Socks5? .*rejected|authentication failed|SOCKS .*auth/i, "Socks5 代理拒绝连接：账号密码可能错误，或该节点不允许当前连接方式"],
  [/Socks client connection timed out|Socks5? .*timed out/i, `Socks5 代理连接超时。${PROXY_VPN_HINT}`],
  [/connect ECONNREFUSED|ECONNREFUSED/i, "连接被拒绝：代理未开启、端口错误，或本机防火墙拦截。请确认代理软件已启动且端口一致"],
  [/connect ETIMEDOUT|ETIMEDOUT/i, `连接超时：网络或代理节点不稳定。${PROXY_VPN_HINT}`],
  [/read ECONNRESET|write ECONNRESET|ECONNRESET/i, `连接被重置：代理/VPN 中途断开。${PROXY_VPN_HINT}`],
  [/ECONNABORTED/i, `连接中止：节点或网络中断。${PROXY_VPN_HINT}`],
  [/ENOTFOUND|getaddrinfo/i, "无法解析域名：请检查本机网络，或开启代理后使用代理 DNS"],
  [/EHOSTUNREACH/i, `无法到达主机。${PROXY_VPN_HINT}`],
  [/EPIPE/i, `连接管道已断开。${PROXY_VPN_HINT}`],
  [/EPROTO/i, "协议错误：代理类型可能选错。Socks5 节点请选 Socks5，HTTP 节点请选 HTTP/HTTPS"],
  [/socket hang up/i, `连接被中断（socket hang up）。${PROXY_VPN_HINT}`],
  [
    /Client network socket disconnected before secure TLS connection was established/i,
    `TLS 握手失败：代理不稳定或节点不可用。${PROXY_VPN_HINT}`,
  ],
  [/certificate|CERT_|UNABLE_TO_VERIFY/i, "证书校验失败：请勿使用会劫持 HTTPS 的代理；可强制系统时间正确后重试"],
  [/wrong version number/i, "SSL/TLS 版本不匹配：代理类型可能选错（常见于把 Socks5 当成 HTTP 使用）"],
  [/fetch failed/i, `网络请求失败。${PROXY_VPN_HINT}`],
  [/Request timeout|请求超时|timeout/i, `请求超时。${PROXY_VPN_HINT}`],
  [/Unauthorized|401/i, "未授权（401）：请检查 API Key 是否正确、是否过期，或账号是否开通 Square OpenAPI"],
  [/403 Forbidden|403/i, "访问被拒绝（403）：Key 无权限，或当前 IP/代理被风控。可换节点或检查 Key 权限"],
  [/404 Not Found|404/i, "接口不存在（404）"],
  [/429|Too Many Requests/i, "请求过于频繁（429），请稍后再试"],
  [/502 Bad Gateway|502/i, `网关错误（502）：代理或上游服务异常。${PROXY_VPN_HINT}`],
  [/503 Service Unavailable|503/i, "服务暂不可用（503），请稍后再试"],
  [/504 Gateway Timeout|504/i, `网关超时（504）。${PROXY_VPN_HINT}`],
];

/** 去掉重复的「操作失败：」前缀，避免多层 wrap 叠字 */
function stripFailurePrefix(message) {
  let text = String(message || "").trim();
  while (/^操作失败[：:]\s*/.test(text)) {
    text = text.replace(/^操作失败[：:]\s*/, "").trim();
  }
  // 若曾被误标成网络/代理异常，去掉外壳后再识别业务码
  text = text.replace(/^网络\/代理异常[：:]\s*/i, "").trim();
  text = text.replace(/。若正在使用 VPN[\s\S]*$/i, "").trim();
  return text;
}

function matchBinanceBizError(text) {
  const raw = String(text || "");
  for (const [pattern, zh] of BINANCE_BIZ_MAP) {
    if (pattern.test(raw)) return zh;
  }
  return null;
}

/** 已是面向用户的完整中文说明（含我们生成的提示） */
function isReadyChineseHint(message) {
  const text = String(message || "");
  if (!/[\u4e00-\u9fff]/.test(text)) return false;
  // 已含排查建议或完整业务文案时不再包一层
  if (/请检查|请确认|请换|请稍|请先|无法连接|未配置|代理|验证成功|API Key|自定义服务商|接口不存在（404）|币安广场 API Key/.test(text)) {
    return true;
  }
  // 纯中文短句也直接返回
  const withoutSafeEn = text.replace(/binance|API|Key|TLS|HTTP|HTTPS|SOCKS|Socks5|DNS|VPN|IP|OpenAPI/gi, "");
  return !/[A-Za-z]{4,}/.test(withoutSafeEn);
}

function collectErrorText(errOrMessage) {
  if (typeof errOrMessage === "string") return errOrMessage;
  const parts = [];
  let current = errOrMessage;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (current.message) parts.push(String(current.message));
    if (current.code != null) parts.push(String(current.code));
    current = current.cause;
  }
  return parts.filter(Boolean).join(" | ") || "未知错误";
}

export function toChineseError(errOrMessage) {
  const raw = collectErrorText(errOrMessage);
  let trimmed = stripFailurePrefix(raw);
  if (!trimmed) return "未知错误";

  // 业务码优先：即使已被误包成「网络/代理异常」也要纠正
  const biz = matchBinanceBizError(trimmed) || matchBinanceBizError(raw);
  if (biz) return biz;

  if (isReadyChineseHint(trimmed)) return trimmed;

  for (const [pattern, zh] of ERROR_MAP) {
    if (pattern.test(trimmed) || pattern.test(raw)) return zh;
  }

  if (/[A-Za-z]/.test(trimmed)) {
    return `网络/代理异常：${trimmed}。若正在使用 VPN 或独立代理，请换节点后重试，并确认 IP、端口、账号密码正确。`;
  }
  return trimmed;
}

export function wrapErrorZh(err) {
  const message = toChineseError(err);
  if (err instanceof Error) {
    const next = new Error(message);
    next.cause = err;
    next.code = err.code;
    return next;
  }
  return new Error(message);
}
