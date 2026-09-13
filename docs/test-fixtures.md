# 知径 · Mock Fixture

## 使用方式

开发环境默认使用 `ZHIJING_MOCK_MODE=true`。fixture 只模拟服务端适配层，不模拟浏览器行为和真实知乎网络。

## 目录约定

实现代码落地后使用以下结构：

```text
fixtures/
├── outline-calculus.json
├── resources-limits.json
├── resources-empty.json
├── upstream-timeout.json
├── upstream-rate-limited.json
└── outline-invalid.json
```

## 最小成功 fixture

### outline

```json
{
  "topic": "微积分",
  "overview": {
    "what": "研究变化率、累积量与函数性质的数学分支",
    "gain": "能够理解极限、导数、积分及其基础应用",
    "duration": "约 12 小时"
  },
  "nodes": [
    {"id":"functions","title":"函数基础","level":1,"summary":"理解变量、函数与图像","query":"函数基础 入门"},
    {"id":"limits","title":"极限","level":1,"summary":"理解趋近和连续","query":"微积分 极限 入门"},
    {"id":"derivatives","title":"导数","level":2,"summary":"理解瞬时变化率","query":"微积分 导数 入门"},
    {"id":"integrals","title":"积分","level":2,"summary":"理解累积与面积","query":"微积分 积分 入门"},
    {"id":"series","title":"级数","level":3,"summary":"理解无穷展开","query":"微积分 级数 进阶"},
    {"id":"applications","title":"应用","level":3,"summary":"连接建模与实际问题","query":"微积分 应用"}
  ],
  "edges": [
    {"from":"functions","to":"limits","type":"main"},
    {"from":"limits","to":"derivatives","type":"main"},
    {"from":"limits","to":"integrals","type":"main"},
    {"from":"derivatives","to":"series","type":"branch"},
    {"from":"integrals","to":"applications","type":"main"}
  ]
}
```

### resource

fixture 至少包含 3 条 `Data.Items`，字段按 `api-contract.md` 的知乎搜索字段填写，覆盖 `Article` 和 `Answer` 两种 `ContentType`。

## 异常 fixture

- `resources-empty`：`Code: 0`、`Data.Items: []`、`Data.EmptyReason` 有值。
- `upstream-timeout`：适配层抛出 `UPSTREAM_TIMEOUT`，客户端显示节点级重试。
- `upstream-rate-limited`：上游 code `30001` 或 `30002`，停止主动重试并提示额度或频率限制。
- `outline-invalid`：直答 content 是无法解析的 JSON，第一次失败后允许重试一次，第二次进入 `OUTLINE_INVALID`。

## 验收场景

1. mock 模式生成地图不需要 Access Secret。
2. 单个资源为空时其他节点继续加载。
3. 单个资源超时时地图仍可操作。
4. 重复 SSE 事件不会重复创建节点或资源。
5. 关闭 mock 后，缺少 `ZHIHU_ACCESS_SECRET` 时服务端明确返回鉴权错误。
