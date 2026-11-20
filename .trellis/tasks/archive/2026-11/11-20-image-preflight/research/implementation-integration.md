# 本机图片预审与共享门禁接入

2026-11-20。依据本任务 PRD/design/implement 和 implement.jsonl 实施；未提交、推送或调用生产服务。

## 修改

- `src/lib/moderation/check.ts` 保持单一共享入口：先执行真实 `assertModerationImages`；有参考图时等待 `checkLocalImages(images)`；只有全部通过后才构造远程审核 URL、请求正文和 fetch。
- 纯文本不调用本机图片检查。本机返回 blocked 时直接阻止；本机异常沿用现有“内容审核暂时无法完成”响应，不发送远程审核请求。
- 阻断结果增加可选 model；ContentReview 的 `aiModel` 使用 `outcome.model ?? cfg.aiModel`。本机拒绝沿用 `kind=ai_moderation`、`category=sexual`；远程拒绝仍记录配置中的远程模型。没有数据库迁移或新开关。
- 本机与远程接收同一组参考图；没有生成、变换、分离或替换原图字节，没有改动顺序。未编辑 local-images、runtime、package 或 Worker 文件。

## 回归证据

- `moderation-check.test.ts` 保留原 64 项，新增 5 项：纯文本不启动本机检查、本机拒绝无 fetch 且模型准确、本机异常无 fetch/违规记录、等待全部 16 张原图并保持字节顺序、通过本机后仍需通过远程审核。既有无效 PNG 回归额外断言本机检查尚未调用；没有 mock 掉图片格式校验。
- `external-generation-service.test.ts` 新增 2 项实际模块接线检查：服务调用真实 `assertExternalGenerationAllowed` 和真实图片格式校验，只模拟本机检测结果。拒绝和异常均不 fetch、不上传、不扣费、不建任务。输入均使用合成有效 PNG。
- red：共享入口改动前，两个目标文件合计 6 failed / 71 passed；失败落在本机检查未接入和外部服务没有经过该检查。
- green：`moderation-check.test.ts`、`external-generation-service.test.ts`、`generate-route-security.test.ts`、`canvas-generate-route.test.ts`、`gateway-client.test.ts`，共 5 suites / 159 tests 通过（`node node_modules/vitest/vitest.mjs run ... --maxWorkers=2`）。
- 3 个修改源码/测试文件 ESLint 通过，`git diff --check` 通过。

这些测试验证共享编排和失败边界，不宣称验证真实模型识别率、生产内存或推理速度；真实模型/线程队列与完整发布检查由对应分工执行。
