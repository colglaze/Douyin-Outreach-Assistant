# REQ-20260929-04 — 多模型接入

## 目标

配置中心可快速切换 DeepSeek、LongCat 与原有 OpenAI，也保留自定义 OpenAI 兼容接口。文字润色和作品封面识别按所选模型能力运行。

## 范围与验收

- 提供提供商快捷选项；切换时填入官方 Chat Completions 完整端点和默认模型，清空旧 API Key，避免把旧密钥发给新提供商。
- 端点和模型字段始终可编辑，修改后作为自定义配置保存；旧设置无须迁移即可继续使用。
- DeepSeek `deepseek-flash` 用于文字润色及图像文字提取；LongCat `LongCat-2.0` 用于文字润色，其官方 Chat Completions 文档注明仅支持文字，因此封面识别跳过并提示。自定义端点的图像能力由用户所配模型决定。
- 两个预设的短请求关闭思考模式，避免思考内容占用短输出额度；自定义端点不注入该参数。
- 未配置 Key 时沿用原文；不要求用户向本项目提供 Key，不内置 Key，也不在日志输出 Key。

## 非范围

- 管理多个提供商密钥、代理后端、模型列表查询、账户充值与实际付费请求。

## 参考

- DeepSeek 官方：[首个 API 请求](https://api-docs.deepseek.com/guides/harness)、[图像输入](https://api-docs.deepseek.com/guides/vision/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- LongCat 官方：[API 概述](https://longcat.chat/platform/docs/APIDocs.html)、[Chat Completions](https://longcat.chat/platform/docs/api/chat.html)
