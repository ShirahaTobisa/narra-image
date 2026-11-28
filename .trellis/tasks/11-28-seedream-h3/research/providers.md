# 接口核对（2026-11-28）

## Seedream
文档：https://docs.apimart.ai/en/api-reference/images/seedream-5-5/generation.md
任务：https://docs.apimart.ai/en/api-reference/tasks/status.md
完整文档：D:/tools/codex/tmp/narra-seedream55.md。

POST https://api.apimart.ai/v1/images/generations，Bearer，JSON model=seedream-5-5,n=1。image_urls支持data URI。用户限1张参考。size=auto默认2K，必须显式size=1K或比例+resolution=1K。仅png/jpeg，不启用layer_decomposition；nsfw_check默认false。响应data[0].task_id；GET /v1/tasks/id响应data.status=pending/processing/completed/failed/cancelled，成功data.result.images[].url是字符串数组。

## H3
文档：https://h3.coolhs.com/docs；纯文本：https://h3.coolhs.com/docs.md
完整本地文档：D:/tools/codex/tmp/narra-h3-docs.md。

MiniMax H3视频，对外模型h3、原生preset=reference。先支持单参考、4/6/8秒、最长边1440、32倍数；UI沿用720p三种比例。
原生/api/v1支持幂等且卡密耗尽后仍能查任务/下载。POST /uploads表单files，返回items[].ref；POST /jobs JSON preset,prompt,width,height,seconds,images(ref数组)，Idempotency-Key用稳定任务ID。
响应{job:{id:number,status,width,height,seconds,has_video,has_poster,...}}；GET /jobs/id状态pending/running/done/failed/cancelled。
GET /jobs/id/video?download=1与/poster需要Bearer卡密，302跳CDN，保留3天。用户明确透传且禁止显示上游地址，必须本站后端跟跳转并流式返回；Range/取消透传，凭据不能转发CDN。

## 保持
跳过内容审核不跳过文件格式、权限、限额或积分。未知提交结果保持现有防重与退款规则。GPT审核、广场和头像审核保持。
