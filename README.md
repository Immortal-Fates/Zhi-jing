# 知径

知乎黑客松项目基础脚手架。当前不包含用户登录或 OAuth；核心进度使用浏览器 `localStorage`。

## 当前状态

文档、接口契约和 mock 约定已准备好；应用功能仍按 `docs/prd.md` 分阶段实现。当前已迁移到 Next.js App Router，服务只提供基础健康检查和脚手架首页。

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
