# 币安广场批量发帖工具

基于币安官方 Square OpenAPI 的 Web 批量发帖工具，支持短帖、长文章、带图帖子。

## 功能

- Web 操作界面，可视化管理帖子列表
- 批量发布，可设置发帖间隔（防触发限流）
- 支持纯文本短帖、长文章（带标题 + 封面）
- 支持图片帖（最多 4 张）
- JSON / 文本格式批量导入
- 实时发布进度（SSE 推送）

## 前置要求

1. **Node.js 18+**
2. **币安广场创作者 API Key**  
   前往 [创作者中心](https://www.binance.com/square/creator-center/home) 创建  
   > API Key 仅用于发帖，不涉及账户资产或交易

## 快速开始

零外部依赖，只需 Node.js 18+：

```bash
node server.js
```

或使用 npm：

```bash
npm start
```

浏览器打开 **http://localhost:3456**

## 使用步骤

1. 点击右上角「设置」，粘贴并保存 API Key
2. 点击「添加帖子」逐条添加，或使用「导入」批量导入
3. 设置发帖间隔（建议 3–5 秒）
4. 点击「开始批量发布」

## 导入格式

### JSON

```json
[
  { "text": "Hello #crypto $BTC" },
  { "text": "深度分析正文...", "title": "2026 市场展望" }
]
```

### 文本（每行一条）

```
BTC 看涨 #crypto
深度分析正文|2026 市场展望
```

格式：`内容|标题`，标题可选。

## 限制说明

| 项目 | 限制 |
|------|------|
| 每日发帖 | 100 条 / API Key |
| 每日上传 | 400 次 |
| 短帖图片 | 最多 4 张 |
| 长文章封面 | 1 张 |

## API Key 存储

Key 保存在本地：`~/.config/binance-square/openapi-key`（权限 600）

也可通过环境变量设置：

```bash
set BINANCE_SQUARE_OPENAPI_KEY=your_key_here
npm start
```

## 常见错误

| 错误码 | 说明 |
|--------|------|
| 220003 | API Key 不存在 |
| 220004 | API Key 已过期 |
| 220009 | 今日发帖已达上限 |
| 20002/20022 | 内容含敏感词 |
| 20013 | 内容长度超限 |

## 技术栈

- Node.js + Express
- 币安 Square OpenAPI（官方接口）
- 纯 HTML/CSS/JS 前端，无构建步骤

## 免责声明

请遵守币安广场社区规范。本工具仅供合法内容发布，请勿用于 spam 或违规内容。使用本工具产生的后果由使用者自行承担。
