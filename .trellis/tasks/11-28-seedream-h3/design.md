# 设计

共享 dedicated-models.json 定义公开限制，不放供应商地址。服务端组合匹配 api.apimart.ai/v1 + seedream-5-5，h3.coolhs.com + h3 才可跳过审核。先选定渠道再审核，网页/外部API/网关一致。专用模型显式匹配，Node与Go都禁止wildcard改投GPT。

Seedream JSON提交（n=1、size=1K或比例+resolution=1K、data URI参考图），轮询tasks后复用图片保存。H3使用原生/api/v1上传、jobs幂等提交及轮询，避免/v1最后额度耗尽后无法查结果。先只做reference基础档。

H3 GeneratedVideo复用UPSTREAM和上游任务媒体URL，序列化换成本地video ID授权代理URL。代理核验所有权/管理员、读取服务端密钥、手动跟随公网CDN跳转且不转发凭据，过滤响应头，支持Range及取消。禁止浏览器302和视频落地。过期给明确提示。

前端按模型呈现参数；后台补配置说明，密钥由管理员配置。

新增 ModelDailyUsage 记录每日名额。GenerationJob INSERT触发器对模型/UTC+9日期取事务锁，核验总量10与单账号1，再原子记录；所有Node/Go入口自然共用。job删除设null保留用量；明确失败已退积分且无部分结果时UPDATE触发器释放。UNKNOWN/RESULT_PERSIST保留。API预检仅改善提示，数据库负责并发最终裁决。余额API返回聚合数据，不返回其他用户标识。暂不部署。
