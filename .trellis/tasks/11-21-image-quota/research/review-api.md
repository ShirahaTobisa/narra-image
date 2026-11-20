# API / 网关独立复核

2026-11-21，trellis-check。只读检查其他代理修改的 `external-api.ts`、`gateway-client.ts` 及对应测试；未修改其实现/测试，未连接外网、生产或真实生图服务。

## 已确认的问题：提前发出 HTTP 200

P2，业务额度确实拦截，但部分真实路由不满足“超额返回429”。

- legacy `src/app/v1/images/generations/route.ts:50`、`images/edits/route.ts:50` 把 `runExternalGeneration` 放在 `openAiImageJsonResponse` callback 中。`src/lib/external-api/http.ts:126` 先发空白保活，`:143` 构造默认200响应；Kelivo UA 的quota异常随后只被写成 JSON error。
- legacy `src/app/v1/responses/route.ts:83` 在完成准入前返回 SSE，`:111` 先发 `response.created`，然后才 await 含quota的payload；超额变成HTTP200的 `response.failed`，其type还固定为 `invalid_request_error`。
- 普通JSON、chat路径，以及网关图片quota先await服务再返回保活，不受这个准入时机问题影响。它不表示超额请求继续扣费/提交上游，也没有线上事故证据。

本机使用真实helper、合成 `ApiRateLimitError`（无网络）复现：

```powershell
node --import tsx --input-type=module -e "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const{openAiImageJsonResponse}=require('./src/lib/external-api/http.ts'); const{ApiRateLimitError}=require('./src/lib/api-errors.ts'); const request=new Request('https://unit.invalid/v1/images/generations',{headers:{'user-agent':'Kelivo'}}); const response=await openAiImageJsonResponse(request,async()=>{throw new ApiRateLimitError('quota fixture')}); console.log(JSON.stringify({status:response.status,body:JSON.parse(await response.text())}));"
```

实际输出 `status:200`、`error.code:rate_limit_exceeded`。已报告主代理并交API代理修复：在任何保活/SSE开始前完成一次API+图片额度准入，再进入原生成等待；不能用公开 `skipQuota` 开关绕过，也不能两处重复计数。`startExternalGeneration` 可返回已准入的结果Promise包装，注意 async函数直接返回Promise会等待整个任务、破坏原保活。新增真实路由429覆盖后再复核。

## 其它检查结果

- `external-api.ts:184-196`、`gateway-client.ts:244-256` 都先执行既有API开关/Key请求限制，再按真实 `user.id` 消费共享图片额度，然后才审核；超额在输出预留、积分扣减、原图上传及网关fetch之前抛429。
- 两者只计算一次有效 count。计费使用同值；legacy任务count/creditsSpent、输出预留和网关payload.count/billing.creditsSpent一致。图生图多参考图和count4都归一为1。
- legacy条件扣费在任务事务内，余额19且费用20时抛错回滚；尚未交Worker失败仍按任务记录的实际 `creditsSpent` 补偿。交Worker之后的等待超时/UNKNOWN没有新增退款路径。
- 网关先预扣实际cost；上传失败在forwarding前补同额，进入转发后只由 `runThroughGateway` 决定补偿，外层不再重复退。明确失败且DB确认无任务可补20；任务存在或状态查询失败保留不确定性、不退20。
- 新测试实际运行真实credits和共享limiter，覆盖4张扣20、19余额拒绝、图生图count4只占1、legacy4张→另一Key网关2张拒绝→再另一Key1张成功、同用户第四Key继续被拒、另一用户独立。拒绝断言审核/预留/扣费/fetch不增加。
- 网关新增确定失败 `increment:20` 恰好一次、已建job的504不退、连接失败且状态查询失败不退。退款的跨调用幂等仍由任务退款函数既有CAS负责；普通用户不可提供内部jobId或billing字段。

本次只读检查没有发现新的数量、金额或退款阻断项。以上是代码及隔离测试覆盖检查，不代替真实PostgreSQL事务验收或生产压力验证。

## 修复后独立复核：问题关闭

已只读核对最终实现和新增真实路由测试：

- `external-api.ts` 的 `startExternalGeneration` 先完成原API限流和共享图片限额，再返回 `{ result: Promise<Job> }`。包装保留原有保活，不会因为async直接返回Promise而等待整次生成。实际执行函数为私有 `runAcceptedExternalGeneration(args,count)`，没有导出绕过门禁的skip参数。
- 原 `runExternalGeneration` 经start执行，三个legacy流式/保活路由显式await start后才构造response。因此准入错误直接到外层 `openAiError`，不会提前发HTTP200，也不重复计数。
- `external-generation-service.test.ts` 新增三条真实路由回归：真实服务先以不同Key用满4+1张，同用户随后调用Kelivo generations、Kelivo multipart edits、stream=true responses，各自都断言实际 `Response.status===429`、JSON `rate_limit_error/rate_limit_exceeded`，审核、事务、扣费、预留、存图和fetch均未发生。没有mock共享计费/图片limiter/start/路由，只有认证、数据库及外部I/O隔离。
- 正例从真实Kelivo路由提交n4，得到成功结果及count4/creditsSpent20，再用另一Key提交1张成功，保留只计一次语义。既有路由测试继续验证未结束生成也能及时收到保活。

实现代理报告service/routes/gateway三套58/58通过及六文件lint/diff通过，并由auth代理独立重跑确认；本代理只读复核最终代码/断言，没有重复跑同一组或声称运行全套。原P2已关闭，未发现新增阻断项；主代理继续全量测试与构建。
