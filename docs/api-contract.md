# 知径 · API 契约

## 1. 约定

- 所有内部接口返回 JSON；生成接口额外支持 SSE。
- 请求体使用 UTF-8 JSON。
- 外部知乎 API 只在服务端调用。
- 除 `GET /api/map` 未命中外，业务失败均使用非 2xx 状态码。
- Access Secret 通过 `ZHIHU_ACCESS_SECRET` 注入，不从前端请求传入。
- `ZHIJING_MOCK_MODE=true` 时不调用知乎接口，使用固定 fixture。

## 2. 统一错误

```json
{
  "ok": false,
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

成功返回 `KnowledgeMapOutline`，节点数量 6–10，层级为 1、2、3，边不能成环。

### `POST /api/resources`

请求：

```json
{ "topic": "微积分", "nodeId": "limits", "query": "微积分 极限 入门" }
```

成功返回：

```json
{
  "ok": true,
  "nodeId": "limits",
  "state": "ready",
  "resources": []
}
```

`state` 可为 `ready`、`empty` 或 `error`。成功但没有合格资源时使用 `empty` 和空数组。

### `GET /api/map?topic=微积分`

- 命中：`200`，返回完整 `KnowledgeMap`。
- 未命中或过期：`404`，返回 `MAP_NOT_FOUND`。
- `topic` 必须先按 trim、Unicode 小写、去除首尾标点和连续空白进行归一化。

### `GET /api/health`

```json
{ "ok": true, "project": "zhijing", "mockMode": true }
```

不得返回 Access Secret、环境变量值或完整上游错误正文。

## 4. SSE

响应头：

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

事件格式：

```text
event: outline
data: {"topic":"微积分","mapId":"map_x","nodes":[],"edges":[]}

event: resource_ready
data: {"nodeId":"limits","state":"ready","resources":[]}

event: complete
data: {"mapId":"map_x","completedNodeCount":11}
```

事件名为 `outline`、`resource_ready`、`resource_empty`、`resource_error`、`complete`。节点事件必须带 `nodeId`；事件允许重复，客户端必须按 `mapId + nodeId` 幂等更新。

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
  "completedNodeIds": ["limits"],
  "updatedAt": 1760000000000
}
```

节点 ID 必须包含地图作用域，推荐格式 `map_<normalizedTopic>_<nodeId>`，避免不同地图的同名节点互相污染。清除进度只删除该 key，不删除地图缓存。
