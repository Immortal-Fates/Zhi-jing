# 知径 · API 契约

## 1. 约定

- 所有内部接口返回 JSON；生成接口额外支持 SSE。
- 请求体使用 UTF-8 JSON。
- 外部知乎 API 只在服务端调用。
- 独立接口或整次生成失败使用非 2xx；JSON 生成的部分资源失败返回 `200` 和 `status: "partial"`。
- 所有应用 JSON 结果（包括错误）和每个 SSE 事件均包含 `mockMode`。该值由服务端配置决定，浏览器不能覆盖。
- Access Secret 通过 `ZHIHU_ACCESS_SECRET` 注入，不从前端请求传入。
- `ZHIJING_MOCK_MODE=true` 时不调用知乎接口，使用固定 fixture。

## 2. 统一错误

```json
{
  "ok": false,
  "mockMode": true,
  "error": {
    "code": "INVALID_TOPIC",
    "message": "请输入学习话题",
    "retryable": false
  }
}
```

内部错误码：

| code | HTTP | retryable |
|---|---:|---:|
| `INVALID_TOPIC` | 400 | false |
| `NOT_LEARNABLE` | 422 | false |
| `OUTLINE_INVALID` | 502 | true |
| `UPSTREAM_AUTH` | 502 | false |
| `UPSTREAM_RATE_LIMITED` | 429 | true |
| `UPSTREAM_TIMEOUT` | 504 | true |
| `UPSTREAM_ERROR` | 502 | true |
| `QUOTA_EXHAUSTED` | 429 | false |
| `MAP_NOT_FOUND` | 404 | false |

## 3. 内部接口

### `POST /api/outline`

请求：

```json
{ "topic": "微积分" }
```

成功返回 `KnowledgeMapOutline` 的字段及 `mockMode`，节点数量 6–10，层级为 1、2、3，边不能成环。

仅成功收到直答内容但 JSON 解析或大纲校验失败（`OUTLINE_INVALID`）重试一次。超时、网络、鉴权、频率、额度及 `NOT_LEARNABLE` 不自动重试。适配层负责协议和校验，上层服务负责这一重试策略。

### `POST /api/resources`

请求：

```json
{ "topic": "微积分", "nodeId": "limits", "query": "微积分 极限 入门" }
```

成功返回：

```json
{
  "ok": true,
  "mockMode": true,
  "nodeId": "limits",
  "state": "empty",
  "resources": [],
  "weight": 0
}
```

成功 `state` 只可为 `ready` 或 `empty`，最多 3 条资源。失败使用非 2xx 统一错误，不返回 `ok: true, state: error`。`weight` 为所选资源 score 之和。

候选集内归一化 RankingScore 和互动分后按 PRD 的 0.6/0.4 公式排序；缺失 RankingScore 时使用搜索次序信号。同分保持原有顺序。尚无认证加分映射，authorityWeight 为 0。去重并过滤非 HTTPS/非知乎原文链接及标题中明显的广告、推广、书单和汇总标记；本阶段不声称具备完整语义相关性或广告识别能力。

### `GET /api/map?topic=微积分`

- 命中：`200`，返回完整 `KnowledgeMap`。
- 未命中或过期：`404`，返回 `MAP_NOT_FOUND`。
- `topic` 必须先按 trim、Unicode 小写、去除首尾标点和连续空白进行归一化。

### `POST /api/generate`

请求：`{ "topic": "微积分" }`，`Content-Type: application/json`。

- 默认（`Accept: application/json`）：等待任务结束，`200` 直接返回 `KnowledgeMap`，含 `mapId`、`mockMode`、`progressScope`、`status`、`completedNodeCount`、`failedNodeCount`、`generatedAt` 和所有节点状态。`complete` 地图另有 `expiresAt`，`partial` 无过期时间且不缓存。
- `Accept: text/event-stream`：返回下节事件流；命中缓存也回放 `outline → 节点事件 → complete`，不切换为 JSON。
- `status: complete|partial` 只表示生成结果，与用户是否已学无关。所有节点 `ready/empty` 则 complete；任一节点 error 则 partial，JSON 仍为 `200`。`completedNodeCount` 为全部已结束节点数，包含 error；`failedNodeCount` 只统计 error。
- 节点错误保留 `state: error`、`errorCode` 及统一 `error`，不让其他节点停止。
- 整次生成失败返回非 2xx；一旦建立 SSE，则以 `generation_error` 终止，不能再改写 HTTP 状态。建立前校验请求及服务配置；大纲调用在建流后执行，大纲失败没有骨架事件。
- 话题原始长度上限 200 字符；`nodeId` 上限 200、`query` 上限 500；请求体上限 8 KiB。非法或缺少参数、非法 JSON 使用 `INVALID_TOPIC`。
- 请求不接受密钥、API 基地址、模式或 mock 场景覆盖；这些字段不会改变服务器配置。

### 生成身份、缓存与任务生命周期

- `mapId` 标识一次生成版本；同一次生成、合并请求、缓存读取及缓存 SSE 回放保留同一 ID。缓存过期或失败后重新生成获得新 ID。
- 缓存及进行中任务的 key 是结构化元组 `[mockMode, mockScenario 或空字符串, normalizedTopic]`，不同模式和 mock 场景不共用结果。
- 仅全部节点正常结束的地图写完整缓存，empty 是正常结果；partial、失败、超时、尚未完成和 `NOT_LEARNABLE` 均不入缓存。
- TTL 从所有节点完成时起计算，默认 24 小时；到期时刻视为失效。进程内最多保留 100 张成功地图，过期懒清理，容量满时移除最早插入项。
- `GET /api/map` 只读缓存，不发起生成。进行中任务不冒充缓存结果。
- 全部生成任务及独立资源接口共享进程内搜索并发上限 5；排队也计入整体期限。请求失败或取消结算后归还名额。
- 任务总超时默认 180 秒，从登记开始计算，可用 `ZHIJING_GENERATION_TIMEOUT_MS` 配置。`ZHIJING_MAP_TTL_SECONDS` 配置 TTL。两者必须为正整数，换算毫秒后不超过计时器范围，否则回退默认值。
- 单个或所有订阅者断开，仅解除该连接订阅，任务仍执行；正常完成后可写缓存。超时终止任务，取消排队及执行中的上游请求，不发布迟到结果、不重试。
- 任务结束或超时后释放计时器、订阅者和进行中记录。晚到订阅者先回放该任务的已有事件，再接收实时事件；不支持跨重启恢复。
- 这些状态仅存在当前 Node 进程，重启丢失，不跨实例共享；不含数据库、持久缓存或全局额度计数。修改运行配置后应重启开发服务。

### `GET /api/health`

```json
{ "ok": true, "project": "zhijing", "mockMode": true }
```

不得返回 Access Secret、环境变量值或完整上游错误正文。

## 4. SSE

响应头：

```text
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

事件格式：

```text
id: %22map_x%22:%22outline%22:%22global%22
event: outline
data: {"topic":"微积分","mapId":"map_x","mockMode":true,"progressScope":"mock:default:微积分","overview":{"what":"示例","gain":"示例","duration":"示例"},"nodes":[],"edges":[]}

id: %22map_x%22:%22resource_empty%22:%22limits%22
event: resource_empty
data: {"mapId":"map_x","mockMode":true,"nodeId":"limits","state":"empty","resources":[],"weight":0}

id: %22map_x%22:%22resource_error%22:%22integrals%22
event: resource_error
data: {"mapId":"map_x","mockMode":true,"nodeId":"integrals","state":"error","resources":[],"weight":0,"errorCode":"timeout","error":{"code":"UPSTREAM_TIMEOUT","message":"地图生成或资源请求超时","retryable":true}}

id: %22map_x%22:%22resource_ready%22:%22derivatives%22
event: resource_ready
data: {"mapId":"map_x","mockMode":true,"nodeId":"derivatives","state":"ready","resources":[],"weight":1}

id: %22map_x%22:%22complete%22:%22global%22
event: complete
data: {"mapId":"map_x","mockMode":true,"status":"partial","completedNodeCount":6,"failedNodeCount":1,"generatedAt":1789257600000}
```

上例节点及资源数组为简略展示，实际骨架含 6–10 个节点，每个节点初始化 `state: pending, resources: [], weight: 0`；实际 ready 事件含 1–3 条资源。

致命错误的互斥终止示例：

```text
id: %22map_x%22:%22generation_error%22:%22global%22
event: generation_error
data: {"mapId":"map_x","mockMode":true,"error":{"code":"NOT_LEARNABLE","message":"请更换为可学习的领域或技能","retryable":false}}
```

- 事件类型复用 `types/api.ts` 的 `SseEvent`，包含 `outline`、`resource_ready`、`resource_empty`、`resource_error`、`complete`、`generation_error`，不新增平行契约。
- 每个事件包含 `mapId` 和 `mockMode`；节点事件另带 `nodeId`、状态、资源和权重，error 事件必须有统一 `error`。
- `outline` 只在大纲校验成功后发出，且必须先于任何节点事件；不等待搜索完成。
- `complete` 与 `generation_error` 只发送其中之一且只发送一次，之后关闭连接，不再产生事件。节点错误本身不是终止事件。
- SSE `id` 将 `mapId`、事件名、`nodeId或global` 分别 JSON 字符串编码后再 URL 编码，以冒号连接；这样也能安全处理未配对 Unicode 代理字符。在缓存回放时不变；客户端以生成 ID 隔离，并按 nodeId 替换更新，不追加重复节点。
- `Last-Event-ID` 不作为断点游标；同话题重连会回放当前任务/缓存，客户端必须幂等处理。过期后收到新 mapId 时应替换旧生成视图。

### 前端订阅与重试

- 前端通过 fetch POST 订阅，网络块不等于事件。增量 UTF-8 解码后按 LF/CRLF/CR 行处理，空行才派发完整事件，多行 data 按换行连接。EOF 前未闭合的事件不得作为完整事件使用，无终止事件的断开显示重新加载提示。
- 每次订阅独立客户端序号，再结合 mapId 防旧响应污染；缓存可能重用 mapId，不能仅依赖 mapId 判断当前请求。
- `POST /api/resources` 没有 mapId，前端捕获订阅序号、mapId、nodeId 后匹配重试结果，并校验 mockMode。重试不写回服务器缓存，原始 complete.status 不因重试而更改。
- 节点重试只更新当前显示的数据；原始 partial 提示保留，并显示当前剩余失败数。空结果是正常 empty，不显示接口失败。
- 页面“重新加载”不绕过缓存；快捷入口同样使用 `/api/generate`，未命中即生成，不承诺预生成内容。

## 5. 知乎外部 API

参考项目级官方 Skill 的 `references/http-api.md`，不要把外部响应直接暴露给浏览器。

### 知乎搜索

- URL：`GET https://developer.zhihu.com/api/v1/content/zhihu_search`
- Query：`Query` 必填，`Count` 可选，最大 10。
- Header：`Authorization: Bearer <secret>`、`X-Request-Timestamp: <秒级 Unix 时间戳>`、`Content-Type: application/json`。
- 读取：`Data.Items[]` 的 `Title`、`ContentType`、`ContentID`、`ContentText`、`Url`、`CommentCount`、`VoteUpCount`、`AuthorName`、`AuthorBadgeText`、`AuthorityLevel`、`RankingScore`、`EditTime`。

### 知乎直答

- URL：`POST https://developer.zhihu.com/v1/chat/completions`
- Header：Bearer Access Secret、秒级 `X-Request-Timestamp`、`Content-Type: application/json`。
- Body：`model`、`messages`、`stream`。
- 首版使用 `model: "zhida-fast-1p5"`、`stream: false`。
- 读取非流式响应的 `choices[0].message.content`，再执行 JSON 清洗和结构校验。

## 6. localStorage

```text
Key: zhijing:progress:v1
Value: {
  "completedNodeIds": ["map_微积分_limits"],
  "updatedAt": 1760000000000
}
```

`mapId` 是生成版本，不可用作 localStorage 进度作用域。`progressScope` 才是稳定话题作用域；真实地图使用 `map_<normalizedTopic>`，与已有推荐的 `map_<normalizedTopic>_<nodeId>` 进度 ID 兼容。mock 使用独立的 `mock:<encodedScenario>:<encodedTopic>`，不得污染真实学习进度。

缓存过期或重启后，相同话题及语义节点 ID 的进度不会因 mapId 更新而清空。要求生成器输出语义稳定的节点 ID；如果模型真正更换了知识点/ID，不能仅按位置或标题盲目迁移进度，旧记录保留而不伪造匹配。此前尚无 localStorage 读写实现，本阶段不实现进度迁移或浏览器读写。

清除进度只删除 `zhijing:progress:v1`，不删除地图缓存。`completedNodeCount` 不读取也不写入此进度。
