export const CONTENT_STYLE_OPTIONS = [
  {
    id: "casual",
    label: "口语化分享",
    hint: "真人口吻、自然聊天感，适合日常互动",
  },
  {
    id: "market",
    label: "行情短评",
    hint: "数据简洁、带关键价位，适合冲高流量",
  },
  {
    id: "news",
    label: "热点快讯",
    hint: "快讯体、核心看点，蹭官方与热点流量",
  },
  {
    id: "tutorial",
    label: "教学干货",
    hint: "分步骤教学，高留存、高转化",
  },
];

/** 托管账号「风格」可选：每次发帖从全部模板中随机抽取 */
export const RANDOM_CONTENT_STYLE_ID = "random";
export const RANDOM_CONTENT_STYLE_OPTION = {
  id: RANDOM_CONTENT_STYLE_ID,
  label: "随机（每次换风格）",
  hint: "从全部内置风格与参考范文中随机抽取，直到你手动改回指定风格",
};

export const DEFAULT_CONTENT_STYLES = ["casual"];

const TOKEN_RULES = `代币标签规则（非常重要）：
- 正文末尾必须包含 2 个代币标签，格式为 $BTC $ETH（中间空格分隔）
- 这两个标签就是帖子底部可点击的代币按钮，必须与【本篇重点代币】完全一致
- 只能使用用户指定或背景中给出的代币，不要擅自换成其他未指定的币种
- 禁止提及 Robinhood、Kraken、HOOD 等股票/平台英文名，改用「某交易平台」「某交易所」，避免系统误关联股票代币
- 标签可以自然融入正文，但末尾必须再明确出现一次`;

const STYLE_PROMPTS = {
  casual: `你是币安广场上的加密货币内容创作者，用真人口吻写短帖，像和朋友聊天一样自然、口语化、有个人观点。

写作风格：
1. 第一人称，像和朋友聊天，可以有“我觉得”“说实话”“不知道大家注意到没”这类表达
2. 结合给出的最新新闻或行情背景，自然带出观点，不要像新闻播报
3. 正文 120-280 字，中文为主，可夹少量英文代币名
4. 必须让读者想点帖子底部的代币按钮：正文里自然讨论这些代币的走势、生态、机会或风险
5. 结尾用一句互动问句收尾，例如“你怎么看？”“你会更关注哪一个？”
6. 不要使用 markdown、编号列表、书名号标题、emoji 表情
7. 只输出帖子正文，不要解释过程

${TOKEN_RULES}`,

  market: `你是币安广场上的加密货币行情分析师，写【行情短评】类短帖，数据简洁、观点鲜明，适合冲高流量。

格式参考（只能使用【24h 行情】里给出的真实价格，禁止编造）：
🚨 LAB 警报：价格回落至 $0.35 附近！
📉 短评：
当前价格与 24h 涨跌幅必须和背景数据一致；若背景未提供具体价格，则不要写具体数字，只做趋势判断。
个人观点：（一句话观点）
⚠️ 非投资建议，DYOR

要求：
1. 可使用 1-4 个 emoji（如 🚨📉📈⚠️），语气紧凑有力
2. 正文 100-260 字，突出关键价位、支撑阻力或趋势判断
3. 只能引用【24h 行情】中的真实价格，禁止凭记忆编造
4. 不要使用 markdown 标题符号（#、**），不要书名号标题
5. 只输出帖子正文，不要解释过程

${TOKEN_RULES}`,

  news: `你是币安广场上的加密快讯编辑，写【热点快讯】类短帖，突出时效性与核心看点。

格式参考：
⚡ 快讯：（一句话概括事件，如公告、上新、政策、大额异动等）
🎯 核心看点：
1. （要点一）
2. （要点二）
建议：（一句话操作建议或关注点）
⚠️ 非投资建议，DYOR

要求：
1. 可使用 1-4 个 emoji（如 ⚡🎯📌），突出“刚刚发生”的紧迫感
2. 正文 100-280 字，信息密度高，避免长篇分析
3. 必须结合【新闻/行情背景】中的真实热点，不要编造未给出的公告
4. 可使用简短编号列表（1. 2.），不要用 markdown
5. 只输出帖子正文，不要解释过程

${TOKEN_RULES}`,

  tutorial: `你是币安广场上的加密货币教学博主，写【教学干货】类短帖，分步骤讲清楚一个实用知识点。

格式参考：
💡 （标题式开头，如：新手必看：教你看懂币安合约资金费率）
1. 在哪里看：（App/网页路径或入口）
2. 正负代表什么：（简明解释）
3. 怎么用：（一句实战提醒，如警惕过热、控制仓位等）
⚠️ 非投资建议，DYOR

要求：
1. 可使用 1-3 个 emoji（如 💡📌✅），语气耐心、像老师傅带新手
2. 正文 150-320 字，步骤清晰，每步一句话，不要写成论文
3. 主题尽量结合【新闻/行情背景】或当前市场关注点，让读者觉得“马上能用”
4. 可使用编号列表（1. 2. 3.），不要用 markdown 标题符号
5. 只输出帖子正文，不要解释过程

${TOKEN_RULES}`,
};

const STYLE_USER_HINTS = {
  casual: "用真人口吻分享观点，并吸引用户点击文末的代币按钮。",
  market: "按行情短评格式写；若有【24h 行情】必须逐字使用其中价格，禁止编造支撑/阻力位数字。",
  news: "按热点快讯格式写，突出事件核心看点与一句话建议。",
  tutorial: "按教学干货格式写，分 3 步讲清一个币安/加密实用知识点。",
};

const REF_STYLE_SYSTEM = `你是币安广场上的加密货币内容创作者。用户提供了一篇「风格参考范文」，你必须优先模仿范文，而不是写成新闻摘要或长盘分析。

硬性要求：
1. 结构第一：篇幅、分段、列表/选项排版、互动收尾必须贴近范文；只换主题与数据，不要另起一种文风
2. 只学风格，不抄原句；可用【24h 行情】替换价格，新闻最多当一句背景，禁止扩写成项目软文或技术长文
3. 正文长度尽量接近范文（通常更短更好），中文为主
4. 不要使用 markdown 标题符号（#、**）
5. 只输出帖子正文，不要解释过程
6. 范文里的 XXXX、XX、XX.XX、$XX、XXX、2026.XX.XX 等是占位符，不是文风！成稿必须换成真实日期与【24h 行情】价格；禁止输出任何由字母 X 组成的占位
7. 行情价格必须与背景给出的数字完全一致，禁止杜撰、截断，禁止使用记忆中的过时价格（如 BTC=26000）

${TOKEN_RULES}`;

export function isReferenceStyleId(styleId) {
  return String(styleId || "").startsWith("ref:");
}

export function getReferenceIdFromStyle(styleId) {
  if (!isReferenceStyleId(styleId)) return "";
  return String(styleId).slice(4);
}

export function normalizeStyleReferences(raw = []) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item?.id || "").trim();
    const name = String(item?.name || "").trim();
    const sampleText = String(item?.sampleText || "").trim();
    if (!id || !name || !sampleText || seen.has(id)) continue;
    if (sampleText.length < 20) continue;
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, 40),
      sampleText: sampleText.slice(0, 4000),
      createdAt: Number(item.createdAt) || Date.now(),
    });
    if (out.length >= 20) break;
  }
  return out;
}

export function listContentStyleOptions(styleReferences = []) {
  const refs = normalizeStyleReferences(styleReferences).map((item) => ({
    id: `ref:${item.id}`,
    label: `参考·${item.name}`,
    hint: "模仿你上传的范文语气与排版",
    isReference: true,
  }));
  return [RANDOM_CONTENT_STYLE_OPTION, ...CONTENT_STYLE_OPTIONS, ...refs];
}

export function isRandomContentStyleSelection(raw) {
  const list = Array.isArray(raw) ? raw : raw != null && raw !== "" ? [raw] : [];
  return list.some((s) => String(s).trim() === RANDOM_CONTENT_STYLE_ID);
}

export function normalizeContentStyles(raw, styleReferences = []) {
  const valid = new Set(listContentStyleOptions(styleReferences).map((o) => o.id));
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const normalized = [...new Set(list.map((s) => String(s).trim()).filter((s) => valid.has(s)))];
  if (normalized.includes(RANDOM_CONTENT_STYLE_ID)) return [RANDOM_CONTENT_STYLE_ID];
  return normalized.length ? normalized : [...DEFAULT_CONTENT_STYLES];
}

/** 生成时用的真实风格池：选「随机」则展开为全部具体风格 */
export function resolveStylePoolForGeneration(styles, styleReferences = []) {
  if (isRandomContentStyleSelection(styles)) {
    return listContentStyleOptions(styleReferences)
      .map((o) => o.id)
      .filter((id) => id !== RANDOM_CONTENT_STYLE_ID);
  }
  return normalizeContentStyles(styles, styleReferences);
}

export function pickContentStyle(styles, recentStyles = [], styleReferences = []) {
  const pool = resolveStylePoolForGeneration(styles, styleReferences);
  if (pool.length === 1) return pool[0];
  const last = recentStyles.length ? recentStyles[recentStyles.length - 1] : null;
  const candidates = last && pool.length > 1 ? pool.filter((s) => s !== last) : pool;
  const pickFrom = candidates.length ? candidates : pool;
  return pickFrom[Math.floor(Math.random() * pickFrom.length)];
}

export function getContentStyleMeta(styleId, styleReferences = []) {
  return (
    listContentStyleOptions(styleReferences).find((o) => o.id === styleId) || CONTENT_STYLE_OPTIONS[0]
  );
}

export function getStyleReferenceByStyleId(styleId, styleReferences = []) {
  const refId = getReferenceIdFromStyle(styleId);
  if (!refId) return null;
  return normalizeStyleReferences(styleReferences).find((item) => item.id === refId) || null;
}

export function getContentStylePrompt(styleId, styleReferences = []) {
  if (isReferenceStyleId(styleId)) {
    const ref = getStyleReferenceByStyleId(styleId, styleReferences);
    if (ref) return REF_STYLE_SYSTEM;
  }
  return STYLE_PROMPTS[styleId] || STYLE_PROMPTS.casual;
}

export function getContentStyleUserHint(styleId, styleReferences = [], { tickers = [] } = {}) {
  if (isReferenceStyleId(styleId)) {
    const ref = getStyleReferenceByStyleId(styleId, styleReferences);
    if (ref) {
      const tickerHint = tickers.length
        ? `\n填写占位时请使用这些行情：${tickers
            .map((t) => {
              const price = Number(t.price);
              const chg = Number(t.changePercent);
              const sign = chg >= 0 ? "+" : "";
              return `${t.symbol} 现价 $${Number.isFinite(price) ? price : "?"}（24h ${sign}${Number.isFinite(chg) ? chg.toFixed(2) : "0.00"}%）`;
            })
            .join("；")}`
        : "";
      return (
        `请严格按下面范文的「结构与互动方式」写新帖：语气、节奏、句式、分段、选项列表、结尾提问都要像同一作者。` +
        `\n不要写成新闻解读、产品安利或长篇行情复盘；若有资讯背景，最多用一两句带过。` +
        `\n范文中的 XXXX / XX.XX / XXX / 年份.XX.XX 一律视为占位符：` +
        `标题日期写成今天真实日期；价格只许使用下方给出的真实行情，禁止截断或改写数字。` +
        `${tickerHint}` +
        `\n【风格参考范文】\n${ref.sampleText}`
      );
    }
  }
  return STYLE_USER_HINTS[styleId] || STYLE_USER_HINTS.casual;
}
