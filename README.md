# 知径

知乎黑客松项目基础脚手架。当前不包含用户登录或 OAuth；核心进度使用浏览器 `localStorage`。

## 当前状态

文档、接口契约和 mock 约定已准备好；应用功能仍按 `docs/prd.md` 分阶段实现。当前已迁移到 Next.js App Router，服务只提供基础健康检查和脚手架首页。

领域模型、知乎服务端适配层、地图生成 API/SSE 及前端核心白板已实现。支持话题输入、三层地图、卫星资源展开、窄屏抽屉、单节点重试、本地学习进度和一级下钻。

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

## 地图生成

运行 `npm run dev`，默认 mock 地址为 `http://127.0.0.1:4173`。仅显式设置 `ZHIJING_MOCK_MODE=false` 才接入真实上游。

```bash
curl http://127.0.0.1:4173/api/health
curl -N http://127.0.0.1:4173/api/generate \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"topic":"微积分"}'
curl 'http://127.0.0.1:4173/api/map?topic=%E5%BE%AE%E7%A7%AF%E5%88%86'
```

`POST /api/generate` 不传 SSE Accept 时返回 JSON；另有 `POST /api/outline`、`POST /api/resources`。partial 地图允许 HTTP 200，但独立资源失败和整次生成失败为非 2xx。所有 JSON/事件携带 mockMode，mock 使用固定示例，不代表输入话题的真实知乎内容。

开发服务的 `ZHIJING_MOCK_SCENARIO` 可选择适配层已有场景，默认 `default`；`empty` 用于完整空资源地图，其余错误可验证终止流。该配置只由服务器设置，请求体不能覆盖，修改后重启服务。

共享任务在所有订阅者断开后继续。总超时默认 180 秒（`ZHIJING_GENERATION_TIMEOUT_MS`），超时取消上游并清理记录；搜索进程共享上限 5。完整缓存 TTL 默认 24 小时（`ZHIJING_MAP_TTL_SECONDS`），最多 100 张，失败/partial 不缓存；不同模式和 mock 场景隔离。缓存仅在进程内，重启、热更新或多实例之间不保证共享。

mapId 是生成版本，progressScope 是稳定学习话题作用域，不能用前者代替 localStorage 进度 ID。完整请求/响应、SSE 终止语义与限制见 `docs/api-contract.md`。

本阶段无数据库、全局额度计数或登录。资源相关性过滤是有限规则，需后续人工验证真实内容质量；未进行真实知乎 API 验收或生产部署。

## 前端白板

打开开发地址即可输入话题；快捷话题与“重新加载”均沿用生成入口的缓存规则，不保证预生成。地图支持拖动、平移、缩放与适配视图；资源加载只更新数据，不重置位置。节点半径映射综合展示权重，非单纯热度。

桌面同时展开一个知识点的最多三个卫星资源；700px 及以下使用支持 Escape 和焦点返回的模态抽屉。mock 资源醒目标注为示例且禁用外链，真实资源仅打开安全知乎链接。支持键盘操作及系统减少动画偏好。

失败节点可单独重试（retryable=false 除外），仅更新当前视图，保留原始 partial 状态并显示剩余失败数。切换话题取消旧订阅与重试，缓存相同 mapId 也通过客户端请求序号隔离。

真实资源点击后记录本地已学状态，存储 key 为 `zhijing:progress:v1`，不上传服务端。顶部进度属于当前地图，支持清除和存储故障降级；mock 资源不标记已学。节点进度 ID 由稳定 progressScope 与节点 ID 的 JSON 元组组成，不使用临时 mapId。

知识点支持一级下钻，面包屑返回恢复父图位置、视口、展开状态及进度。子图加载/失败不修改父图，不能继续递归。根话题在 URL 中保留以支持刷新，父子画布快照仅在当前会话保存。生成响应兼容 JSON/SSE，不增加服务器 progress API 或强制刷新参数。

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
