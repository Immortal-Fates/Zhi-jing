# 知径

知乎黑客松项目基础脚手架。当前不包含用户登录或 OAuth；核心进度使用浏览器 `localStorage`。

## 当前状态

文档、接口契约和 mock 约定已准备好；应用功能仍按 `docs/prd.md` 分阶段实现。当前已迁移到 Next.js App Router，服务只提供基础健康检查和脚手架首页。

领域模型、大纲校验和知乎服务端适配层已实现，尚未接入业务路由或地图页面。

## 开发环境

- Node.js `>=22`
- npm
- 项目级知乎 Skill：`.codex/skills/zhihu`

## 开始

```bash
npm install
cp .env.example .env.local
npm test
npm run check
npm run build
npm start
```

打开 <http://127.0.0.1:4173/>，健康检查地址为 <http://127.0.0.1:4173/api/health>。

## 环境变量

默认 `ZHIJING_MOCK_MODE=true`，不需要凭证即可开发。接入真实知乎接口前：

1. 将 `ZHIJING_MOCK_MODE` 改为 `false`。
2. 通过部署平台 Secret 或当前 Shell 注入 `ZHIHU_ACCESS_SECRET`。
3. 不把真实凭证写入 `.env.example`、源码、日志或提交记录。

`zhihu-cli` 保存的系统钥匙串凭证不会自动注入 Node 服务。需要服务端调用时，使用运行环境的 `ZHIHU_ACCESS_SECRET`。

## 知乎适配层

入口：`src/server/zhihu-adapter.ts`，仅供 Node 服务端使用，不在 Client Component 中导入。

- `createZhihuClient()` 默认使用 mock，无凭证也不会发起网络请求。
- `search(query, count?)` 返回映射后的 `resources`，默认数量 10、最大 10。
- `answer(prompt)` 使用 `zhida-fast-1p5` 和 `stream: false`，提取内容、解析 JSON 后交给 `validateOutline` 严格校验。
- `parseAnswerJson(text)` 是纯解析函数，支持纯 JSON 和完整 JSON 代码块，返回 `unknown`，不修复业务结构。
- `ZhihuAdapterError.apiError` 包含 `code`、`message`、`retryable`；JSON 序列化为 `{ ok: false, error }`。

真实模式从服务端环境变量读取 `ZHIHU_ACCESS_SECRET`、`ZHIHU_API_BASE_URL`。基地址默认 `https://developer.zhihu.com`；覆盖地址必须是受信任的 HTTP(S) 服务，不得来自浏览器输入。`ZHIJING_MOCK_MODE=true` 强制禁止真实请求，客户端选项不能关闭这一保护。超时默认搜索 10 秒、直答 120 秒，可用 `ZHIJING_SEARCH_TIMEOUT_MS`、`ZHIJING_OUTLINE_TIMEOUT_MS` 配置。

mock 复用 `fixtures/`，客户端选项 `mockScenario` 支持 `default`、`empty`、`invalid_json`、`timeout`、`rate_limited`、`quota_exhausted`、`unauthorized`。`empty` 只影响搜索；其他错误场景可用于两种调用。测试注入本地 fetch 替身和虚构凭证，不调用知乎、不读取系统钥匙串。

搜索仅复制资源元数据的白名单字段，忽略未知字段；必要字段缺失返回 `UPSTREAM_ERROR`，不伪装为空结果。`authorBadge` 为认证图片，`authorBadgeText` 为认证文案；图片缺失可省略。保持上游资源顺序和 `rankingScore`，`score` 初始化为 0，相关性过滤、综合评分和 top3 选择由后续业务层负责。摘要仅作为文本数据，不在适配层抓取或保存文章全文。

适配层不自动重试、不跟随重定向、不缓存请求，也不创建 SSE、数据库或业务路由。

## 文档入口

- [项目概念](docs/project-concept.md)
- [项目策划案](docs/project-plan.md)
- [PRD](docs/prd.md)
- [API 契约](docs/api-contract.md)
- [Mock Fixture](docs/test-fixtures.md)
- [Vibe Coding 就绪评估](docs/vibe-coding-readiness.md)

## 开发约束

- 先实现 mock，再接入真实知乎接口。
- 只使用知乎直答和知乎搜索，不引入第三方模型。
- 所有知乎调用必须在服务端。
- 不新增 OAuth、登录、服务端用户进度或文章全文抓取。
- 每完成一个小任务都运行 `npm test` 和 `npm run check`。

```bash
npm test
npm run check
npm run build
npm start
```

项目级官方 Skill 位于 `.codex/skills/zhihu`。本项目是临时测试内容；删除前按官方 Skill 说明清除其 Access Secret，再删除项目目录。
