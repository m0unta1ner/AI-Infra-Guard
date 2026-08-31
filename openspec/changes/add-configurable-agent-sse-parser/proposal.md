# OpenSpec：增加 Agent Scan 配置化 SSE 响应解析

## 1. 变更概述

为 Agent Scan 的自定义 HTTP Provider 增加配置化 SSE（Server-Sent Events）响应解析能力。用户通过 Provider YAML 描述文本增量、最终全文、结束事件和错误事件的匹配条件及字段路径，无需为每一种新的 SSE JSON 结构修改 `adapter.py`。

本变更采用混合兼容方案：

1. Provider 显式配置 `sse` 规则时，优先使用配置化解析器。
2. 未配置 `sse` 时，继续使用 OpenAI、Anthropic、Dify、Coze 等内置解析逻辑。
3. 无法识别内容时返回明确诊断，不再仅返回难以定位的空 `content`。
4. 解析后的结果统一转换为 Agent Scan 已有的 Provider Response，不改变后续扫描流水线。

本变更同时作用于：

- Web 页面“测试联通性”和“Prompt 测试”；
- 正式 Agent Scan 任务；
- Agent Scan 独立 CLI。

## 2. 背景与问题

SSE 标准只规定 `event:`、`data:`、`id:`、`retry:`、注释和空行事件边界，不规定 `data` 中的业务 JSON 结构。不同 Agent 平台使用的文本字段和结束条件存在明显差异，例如：

```text
OpenAI    choices[0].delta.content
Dify      answer
自定义 A  payload.message.text
自定义 B  Object / Type / Status / Text
```

当前 `agent-scan` 在检测到 `Content-Type: text/event-stream` 后调用 `_parse_sse_response()`，其中内置了若干固定格式。自定义格式未命中内置分支时，会被标准化为：

```json
{
  "content": "",
  "raw_sse": true
}
```

页面的 `transform_response` 在 SSE 标准化之后才执行，因此无法通过填写 `Text`、`payload.text` 等表达式补救前一阶段没有提取到内容的问题。

现有处理方式要求用户每遇到一种 SSE 格式就修改 Python 代码并重新构建镜像，存在以下问题：

- 自定义格式无法通过页面或 Provider YAML 独立接入；
- 分支会随平台数量持续增加；
- Webserver 联通测试与 Agent 正式扫描可能因镜像修改不一致产生行为差异；
- 容器内临时修改不可审计、不可复现，重建后会丢失；
- 当前实现读取完整 `response.text` 后才解析，不适合长响应和大响应；
- 错误信息无法区分“未识别 SSE 格式”和“目标确实返回空内容”。

相关社区讨论：

- [Tencent/AI-Infra-Guard Discussion #377](https://github.com/Tencent/AI-Infra-Guard/discussions/377)

## 3. 用户场景

### 3.1 自定义 Agent 接入

用户的 Agent 返回：

```text
:ping

data: {"Object":"content","Type":"text","Status":"in_progress","Text":"你好"}

data: {"Object":"content","Type":"text","Status":"completed","Text":"你好，小伙伴！"}

data: {"Object":"response","Status":"completed"}
```

用户在 Provider YAML 中配置事件映射后，页面联通测试和正式扫描都应得到：

```json
{
  "content": "你好，小伙伴！",
  "raw_sse": true,
  "response_completed": true
}
```

### 3.2 新平台适配

当新的 Agent 平台使用：

```json
{"event":"answer.delta","payload":{"text":"你好"}}
```

用户只需增加：

```yaml
sse:
  require_done: false

  chunks:
    - when:
        event: "answer.delta"
      text_path: "payload.text"
```

不需要修改 Python 源码或重新发布 AIG。

### 3.3 已有 Provider

未配置 `sse` 的 OpenAI、Anthropic、Dify、Coze 和普通 JSON Provider 保持原行为，不要求用户迁移已有配置。

## 4. 目标与非目标

### 4.1 目标

1. 正确解析标准 SSE 事件边界、注释、心跳和多行 `data:`。
2. 通过 YAML 配置事件匹配条件和文本字段路径。
3. 支持增量文本、最终全文、备用最终全文、结束事件和错误事件。
4. 避免同时拼接增量文本与最终全文造成重复。
5. 将不同 SSE 格式统一转换为 Agent Scan Provider Response。
6. 保持现有内置 SSE 和非 SSE Provider 向后兼容。
7. Webserver 联通测试与 Agent 正式扫描使用同一套解析代码和配置语义。
8. 对事件数量、响应字节数、字段路径复杂度和超时设置安全上限。
9. 对未匹配、异常结束和上游错误提供可诊断信息。
10. 提供中文/英文文档和可直接复制的配置示例。

### 4.2 非目标

第一版不实现：

- 在 AIG 前端实时展示被测 Agent 的逐 Token 输出；
- 将 SSE 事件原样转发给浏览器；
- 执行 JSONPath、JMESPath、JavaScript、Python 或任意用户表达式；
- 对加密、压缩或二进制自定义协议做通用解码；
- 自动推断任意 SSE 结构并永久保存推断结果；
- 完整重建跨事件拆分的工具调用参数；
- 同时跟踪一个 SSE 流中的多个并行 Agent 会话；
- 关闭 HTTPS 证书验证作为正式功能；
- 修改 Agent Scan 三阶段检测和漏洞判定逻辑。

复杂协议仍可通过专用 Provider Adapter 或外部协议网关接入。

## 5. 推荐架构

```text
被测 Agent HTTP 响应
        |
        v
Content-Type 判断
        |
        +-- 非 SSE --> 现有 JSON/Text 解析
        |
        `-- SSE
              |
              v
       标准 SSE 传输解析器
       event/data/id/retry/heartbeat
              |
              v
       Provider 事件映射
       configured rules 或 builtin rules
              |
              v
       统一响应聚合器
       completed > fallback_completed > chunks
              |
              v
       ProviderResponseInfo
       output/raw/usage/metadata/error
              |
              v
       Agent Scan 后续检测流水线
```

### 5.1 模块边界

建议将职责拆分为：

```text
adapter.py
  负责 HTTP 请求、Provider 路由和统一结果封装

sse_parser.py（建议新增）
  负责标准 SSE 事件读取、规则匹配、字段提取和内容聚合

Provider YAML
  只描述事件结构，不包含可执行代码
```

如第一版不拆文件，也必须将通用解析逻辑封装成独立类/函数，避免继续扩大 `_parse_sse_response()` 的条件分支。

## 6. Provider 配置协议

### 6.1 完整示例

```yaml
- id: "http"
  label: "Custom SSE Agent"
  config:
    url: "https://agent.example.com"
    endpoint: "/chat"
    method: "POST"
    timeout_ms: 200000
    headers:
      Content-Type: "application/json"
      Accept: "text/event-stream"
    body:
      template_id: "45ad3da78a0f487593f91ece68ac9667"
      message: "{{prompt}}"

    sse:
      require_done: true
      accept_done_marker: true
      max_events: 10000
      max_response_bytes: 4194304

      chunks:
        - when:
            Object: "content"
            Type: "text"
            Status: "in_progress"
          text_path: "Text"

      completed:
        - when:
            Object: "content"
            Type: "text"
            Status: "completed"
          text_path: "Text"

      fallback_completed:
        - when:
            Object: "message"
            Type: "message"
            Status: "completed"
          text_path: "Content[0].Text"

      done:
        - when:
            Object: "response"
            Status: "completed"

      errors:
        - when:
            Object: "error"
          message_path: "Message"

      metadata:
        usage_path: "Usage"
        timing_path: "Timing"
```

配置化 SSE 成功解析后，通常不需要再设置 `transform_response`。如保留该字段，统一响应中的默认内容路径为 `content`。

### 6.2 配置字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sse.require_done` | boolean | 配置 `done` 时为 `true` | 是否必须命中完成规则或允许的 `[DONE]` 标记 |
| `sse.accept_done_marker` | boolean | `true` | 是否将字面值 `[DONE]` 视为正常完成 |
| `sse.max_events` | integer | `10000` | 单次响应允许处理的最大业务事件数 |
| `sse.max_response_bytes` | integer | `4194304` | 所有 `data` 内容的累计最大字节数 |
| `sse.chunks` | rule[] | `[]` | 增量文本事件规则，可匹配多次并按顺序拼接 |
| `sse.completed` | rule[] | `[]` | 最终完整文本规则，成功提取后优先于增量文本 |
| `sse.fallback_completed` | rule[] | `[]` | 主最终文本为空时使用的备用全文规则 |
| `sse.done` | match[] | `[]` | 正常完成事件规则 |
| `sse.errors` | errorRule[] | `[]` | 上游错误事件规则 |
| `rule.when` | object | `{}` | 对 `data` JSON 执行全部相等匹配 |
| `rule.event_name` | string | 空 | 可选，匹配 SSE 的 `event:` 字段 |
| `rule.text_path` | string | 必填 | 从 `data` JSON 提取文本的受限字段路径 |
| `errorRule.message_path` | string | 空 | 从错误事件提取安全错误消息 |
| `sse.metadata.usage_path` | string | 空 | 从完成事件提取 Token Usage，保留原始键名 |
| `sse.metadata.timing_path` | string | 空 | 从完成事件提取耗时信息，保留原始键名 |

### 6.3 配置模型与严格校验

`ProviderConfig` 必须显式增加类型化的 `sse` 字段，不能依赖未声明字段透传：

```python
class ProviderConfig(BaseModel):
    # Existing fields...
    sse: SSEParserConfig | None = None
```

`SSEParserConfig`、文本规则、错误规则和元数据规则都必须禁止未知字段：

```python
class SSEParserConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
```

要求：

- 拼错字段名时在加载 Provider 配置阶段失败，例如 `text_patch` 不能被静默忽略；
- 错误消息应包含字段位置，但不得回显凭据和完整请求体；
- `sse` 存在但没有任何内容规则时拒绝配置；
- `require_done=true` 但没有 `done` 且 `accept_done_marker=false` 时拒绝配置；
- 上限值在配置加载时校验，并在运行时再次应用代码硬上限；
- 旧配置不含 `sse` 时继续正常加载。

### 6.4 字段路径语法

第一版只允许确定性的点路径和数组下标：

```text
Text
payload.text
payload.message.text
Content[0].Text
choices[0].delta.content
```

禁止：

```text
$..Text
[*]
过滤表达式
函数调用
脚本表达式
负数下标
动态键计算
```

建议限制：

- 路径长度不超过 256 字符；
- 路径 token 不超过 32 个；
- 数组下标不超过 10000；
- 仅访问 dict/list/string，不触发对象属性或方法。

### 6.5 匹配语义

`when` 使用严格的“全部条件相等”语义：

```yaml
when:
  Object: "content"
  Type: "text"
  Status: "completed"
```

等价于：

```text
data.Object == "content"
AND data.Type == "text"
AND data.Status == "completed"
```

第一版不支持正则、范围、否定和任意代码表达式。字段不存在时视为不匹配。

如需要匹配嵌套字段，`when` 的键也使用受限路径：

```yaml
when:
  payload.event.type: "answer.delta"
```

### 6.6 多规则语义

- 同一类别中的规则按配置顺序匹配。
- `chunks` 允许一个事件命中第一个适用规则后提取一次，避免重复追加。
- `completed` 保存最后一个成功提取的非空全文。
- `fallback_completed` 仅在 `completed` 没有非空结果时生效。
- `errors` 优先级高于内容和完成判断。
- 同一事件需要先执行错误检查，再提取内容，最后判断 `done`。
- 命中 `done` 后停止读取，并标记 `response_completed=true`。
- 同一事件同时携带最终文本和完成状态时，必须先提取文本再停止读取。

### 6.7 元数据映射

元数据路径只在命中 `done` 的事件中读取。第一版支持 `usage_path` 和 `timing_path`，提取结果放入统一响应的 `metadata`，其中 Token Usage 同时尽可能映射到 `ProviderResponseInfo.token_usage`。

元数据映射遵循与文本字段相同的受限路径语法，不支持表达式和字段重命名。无法提取元数据不影响正文成功，但应在诊断计数中标记。

## 7. 标准 SSE 传输解析

### 7.1 事件边界

解析器必须按 SSE 标准以空行结束一个事件，而不是把每一行独立视为事件。

以下输入属于一个事件：

```text
event: message
id: 42
data: {"content":"第一行"
data: ,"extra":"第二行"}

```

同一事件的多个 `data:` 行使用换行符连接后再尝试 JSON 解析。

### 7.2 支持字段

解析器识别：

- `event:`：事件名称；
- `data:`：业务内容；
- `id:`：事件 ID，保留在元数据中；
- `retry:`：可解析但不控制服务端重连；
- `:`：注释或心跳，忽略业务解析。

未知 SSE 字段应忽略，不导致任务失败。

### 7.3 JSON 与纯文本

- 配置了事件映射时，`data` 默认必须为 JSON object。
- 当 `accept_done_marker=true` 时，字面值 `[DONE]` 视为正常结束；关闭后仅使用配置的 `done` 规则。
- 内置解析器可继续兼容已支持的纯文本 `data`。
- 配置化规则遇到非 JSON `data` 时跳过并计数，不将原始内容直接注入结果。
- 所有事件都无法解析时，返回带计数的诊断错误。

## 8. 内容聚合与统一响应

### 8.1 结果优先级

最终回答按以下优先级选择，不能相加：

```text
completed 非空全文
        >
fallback_completed 非空全文
        >
chunks 增量拼接结果
```

这样可以避免以下事件同时存在时重复：

```text
in_progress: "你好"
in_progress: "！"
completed:   "你好！"
```

最终结果必须是 `你好！`，不能是 `你好！你好！`。

### 8.2 标准化结构

配置化 SSE 解析成功后至少输出：

```json
{
  "content": "完整回答",
  "raw_sse": true,
  "response_completed": true,
  "metadata": {
    "event_count": 11,
    "ignored_event_count": 3,
    "answer_source": "completed",
    "last_event_id": null,
    "usage": null,
    "timing": null
  }
}
```

其中：

- `content` 供现有 `_extract_output()` 自动读取；
- `raw_sse` 保持现有语义；
- `response_completed` 表示是否命中正常结束规则或内置结束标记；
- `answer_source` 为 `completed`、`fallback_completed` 或 `chunks`；
- 元数据不得包含完整 Prompt、API Key 或未脱敏敏感响应。
- `raw` 不得保存完整原始 SSE 流；只保存上述标准化结构，避免抵消增量读取的内存收益和泄露 reasoning/工具参数。

### 8.3 非正常结束

| 场景 | 处理 |
|---|---|
| 命中 `done` 且有内容 | 成功 |
| `accept_done_marker=true` 且命中 `[DONE]` | 成功 |
| 未配置 `done` 且 `require_done=false`，连接正常 EOF 且有内容 | 成功，标记 `completed_by=eof` |
| `require_done=true`，连接 EOF 但未命中完成条件 | 失败，错误为 `incomplete_sse_stream`，不得把部分回答交给扫描引擎 |
| `require_done=false`，连接 EOF 但未命中完成条件且有内容 | 成功但附带 `incomplete_stream=true` 警告 |
| 无任何可提取内容 | 失败，提示规则未匹配及事件计数 |
| 命中 `errors` | 失败，返回经过长度限制和脱敏的错误消息 |
| 超过资源上限 | 失败并中止读取 |
| Read timeout | 失败，保留超时类型，不误报为 Connection refused |

## 9. HTTP 流式读取

当前 `client.request()` 会在解析前读取完整响应。建议改为：

```python
with client.stream(method, url, ...) as response:
    for line in response.iter_lines():
        ...
```

要求：

- 收到事件时增量解析，不在内存保留完整原始流；
- 连接建立、读取、写入和连接池超时可以区分；
- 心跳会产生网络数据并维持 read timeout，但不计入业务事件上限；
- `timeout_ms` 必须真正作用于自定义普通 HTTP 和 SSE HTTP Provider；当前 HTTP 路径只使用 `self.timeout`，实现时必须显式传入 `config.timeout_ms`，不能仅复用 WebSocket 的超时辅助函数；
- HTTP 客户端应区分 connect/read/write/pool timeout。`timeout_ms` 主要控制 read timeout，并设置合理上下限；
- 超时值需要有合理上下限；
- 客户端取消或任务终止时关闭上游流；
- 不自动重试已经开始产生内容的 SSE 请求，避免重复执行被测 Agent 行为。

对于普通 JSON 响应，保持现有非流式读取逻辑。

建议调用边界：

```python
timeout = httpx.Timeout(
    connect=min(timeout_seconds, 10),
    read=timeout_seconds,
    write=min(timeout_seconds, 30),
    pool=min(timeout_seconds, 10),
)
```

`_call_http_provider()` 必须将当前 Provider 的超时配置传给统一 HTTP 请求函数。测试必须证明超过旧默认值但小于 `timeout_ms` 的心跳流可以成功完成。

## 10. 解析优先级与兼容策略

### 10.1 优先级

```text
Provider 配置了 sse
  -> 配置化解析

Provider 未配置 sse
  -> 现有内置 OpenAI / Anthropic / Dify / Coze 解析

仍未提取内容
  -> 明确的 unsupported_sse_format 错误
```

第一版不自动混用配置化规则和内置规则，避免一个事件被两套逻辑重复提取。后续如需要，可增加显式 `fallback_to_builtin`，但默认不启用。

### 10.2 `transform_response`

- 普通 JSON 响应继续按现有方式使用 `transform_response`。
- SSE 配置成功后统一生成 `content`，默认由 `_extract_output()` 自动读取。
- 如用户设置 `transform_response: content`，结果应保持一致。
- 不允许 `transform_response` 直接作用于每一个原始 SSE 事件。
- 文档应明确：SSE 事件级字段使用 `sse.*.text_path`，最终 JSON 字段才使用 `transform_response`。

### 10.3 已有配置

未包含 `sse` 字段的 Provider YAML 不发生行为变化。

Pydantic 配置模型新增字段时，应继续允许读取旧配置，并对未知的 `sse` 子字段给出校验错误，避免用户误以为规则已生效。

## 11. 目标格式配置示例

针对当前实测格式：

```text
:ping

data: {"Object":"response","Status":"created"}

data: {"Object":"content","Type":"text","Status":"in_progress","Text":"你好"}

data: {"Object":"content","Type":"text","Status":"completed","Text":"你好，小伙伴！"}

data: {"Object":"message","Type":"message","Status":"completed","Content":[{"Type":"text","Text":"你好，小伙伴！"}]}

data: {"Object":"response","Status":"completed","Usage":{"InputTokens":100,"OutputTokens":10}}
```

推荐配置：

```yaml
sse:
  require_done: true
  accept_done_marker: true

  chunks:
    - when:
        Object: "content"
        Type: "text"
        Status: "in_progress"
      text_path: "Text"

  completed:
    - when:
        Object: "content"
        Type: "text"
        Status: "completed"
      text_path: "Text"

  fallback_completed:
    - when:
        Object: "message"
        Type: "message"
        Status: "completed"
      text_path: "Content[0].Text"

  done:
    - when:
        Object: "response"
        Status: "completed"

  errors:
    - when:
        Object: "error"
      message_path: "Message"

  metadata:
    usage_path: "Usage"
    timing_path: "Timing"
```

期望输出：

```json
{
  "content": "你好，小伙伴！",
  "raw_sse": true,
  "response_completed": true,
  "metadata": {
    "answer_source": "completed",
    "usage": {
      "InputTokens": 100,
      "OutputTokens": 10
    }
  }
}
```

`Type=reasoning` 的 message/content 不命中上述规则，因此不会进入正式回答。

## 12. 错误模型与可观测性

### 12.1 错误分类

至少区分：

```text
dns_error
connection_refused
tls_verification_failed
connect_timeout
read_timeout
http_status_error
invalid_sse_event
unsupported_sse_format
sse_limit_exceeded
upstream_sse_error
incomplete_sse_stream
```

不得再把所有 `httpx.ConnectError` 统一展示为 `Connection refused`。底层异常可进入受控日志，面向用户的错误消息不得泄露 Token、完整 Header 或敏感响应。

实现错误分类时应优先检查异常类型、`__cause__` 和底层 `errno`，例如 `ssl.SSLCertVerificationError`、`ConnectionRefusedError`、`socket.gaierror` 和 httpcore timeout；不得只依赖英文错误字符串，以免受操作系统、OpenSSL 和本地化差异影响。无法细分时使用通用 `connection_error`，不能错误标记为 `connection_refused`。

### 12.2 诊断元数据

在不包含原始敏感内容的前提下，可以记录：

- HTTP 状态码和 Content-Type；
- 是否识别为 SSE；
- 总事件数、JSON 事件数、匹配事件数和忽略事件数；
- 是否命中完成事件；
- 最终内容来源；
- 总响应字节数和耗时；
- 失败分类。

## 13. 安全要求

1. SSE 配置只能进行受限路径读取和严格相等匹配，不得使用 `eval`、`exec` 或动态脚本。
2. 响应必须受最大事件数、最大字节数和超时限制。
3. 错误消息和日志不得输出 API Key、Authorization Header、完整 Prompt 或完整原始 SSE。
4. 不跟随重定向，除非现有 Provider 有明确且受控的策略。
5. HTTPS 默认必须校验证书。
6. 当前工作区为诊断临时加入的 `verify=False` 必须在正式实现或提交前恢复，不属于本 OpenSpec 功能。
7. 如需信任企业内部证书，应通过容器 CA 信任链或显式 CA Bundle 实现，而不是关闭验证。
8. 配置的上限值必须再次受代码硬上限约束，防止用户配置无限值。
9. 上游错误文本需要限制长度并做控制字符处理。
10. 客户端断开或任务取消时应及时释放上游连接。

建议代码硬上限：

| 项目 | 默认值 | 允许最大值 |
|---|---:|---:|
| 业务事件数 | 10000 | 100000 |
| 响应字节数 | 4 MiB | 16 MiB |
| 字段路径长度 | 256 | 256 |
| 字段路径 token | 32 | 32 |
| 单个提取文本长度 | 1 MiB | 4 MiB |
| 错误消息长度 | 2 KiB | 2 KiB |

## 14. Docker 与部署行为

Agent Provider 联通测试由 Webserver 侧执行，正式 Agent Scan 由 Agent Worker 执行。因此：

- 源码实现必须同时进入 Webserver 和 Agent 镜像；
- 不接受“只进入容器手工修改文件”作为正式交付方式；
- 两个镜像必须使用同一版本的 `agent-scan` 代码和配置模型；
- 构建后分别验证 Web 页面联通测试和正式扫描；
- 预构建镜像发布流程需要同步更新两个镜像；
- 本变更不要求修改 Docker bridge 网络结构。

## 15. 预计代码影响

### 15.1 Python

预计修改或新增：

- `agent-scan/agent_scan/core/agent_adapter/adapter.py`
- `agent-scan/agent_scan/core/agent_adapter/sse_parser.py`（建议新增）
- `agent-scan/agent_scan/core/agent_adapter/providers.yaml`（内置规则如迁移为配置）
- `agent-scan/agent_scan/config/provider_config_zh.json`
- `agent-scan/agent_scan/config/provider_config_en.json`
- `agent-scan/pytests/test_sse_parser.py`（新增）
- `agent-scan/pytests/test_llm_request.py` 或新的 Provider 集成测试

### 15.2 文档

预计修改：

- `agent-scan/README_zh.md`
- `agent-scan/README.md`
- 必要时更新页面 Agent Provider 配置帮助文本

### 15.3 第一版前端范围

第一版采用“原始 Provider YAML 高级配置”方案：

- 不为 `chunks/completed/done/errors` 开发结构化表单编辑器；
- Web 页面继续提交和保存完整 YAML 文本；
- `provider_config_zh.json` 和 `provider_config_en.json` 只增加字段说明、示例或帮助入口，不承担嵌套规则编辑；
- 页面联通测试必须展示配置校验错误和 SSE 解析诊断；
- 后续根据配置协议稳定性另行评估可视化编辑器。

因此第一版不需要新增前端 SSE 规则状态模型，也不扩大现有 Agent 任务 API。

### 15.4 Go 与 API

如果 Provider YAML 由 Go 仅作为文本保存和转发，则不要求改变任务 API 数据结构。需要确认：

- `common/websocket/knowledge2_api.go` 的联通测试能透传新配置；
- `common/agent/agent_task.go` 的临时 Provider 文件不丢失新字段；
- Webserver 与 Agent 的 Python 运行环境一致。

如后续增加前端结构化编辑 `sse`，应作为独立变更同步检查 API 文档和前端序列化兼容性。

## 16. 测试方案

### 16.1 SSE 协议测试

- 单个 `data:` JSON 事件；
- 多个事件以空行分隔；
- 同一事件包含多行 `data:`；
- `event:`、`id:` 和 `retry:`；
- `:ping` 和其他注释心跳；
- CRLF 与 LF 换行；
- `[DONE]`；
- 未知字段；
- 非 JSON `data`；
- 流在事件中间断开。

### 16.2 配置规则测试

- 顶层路径 `Text`；
- 嵌套路径 `payload.text`；
- 数组路径 `Content[0].Text`；
- 嵌套 `when` 路径；
- 缺失字段不匹配；
- 多条件全部匹配；
- 多规则顺序；
- 非法路径拒绝；
- 超长路径拒绝；
- 未知配置字段拒绝或给出明确错误。
- `sse` 字段确认没有被 Pydantic 静默丢弃；
- 拼写错误的 `text_patch` 在配置加载时失败；
- `require_done=true` 但没有可用完成条件时配置失败。

### 16.3 内容聚合测试

- 只有增量事件；
- 只有最终全文；
- 增量和最终全文同时存在时不重复；
- 主全文为空时使用备用全文；
- reasoning 事件被忽略；
- 错误事件优先；
- 完成事件正常终止；
- 同一事件携带最终文本和完成状态时先提取再结束；
- `require_done=true` 未命中完成事件时失败；
- `require_done=false` 时 EOF 部分结果带明确警告；
- `[DONE]` 开启和关闭两种行为；
- 空回答返回可诊断错误。
- Usage/Timing 提取成功和缺失时的行为。

### 16.4 向后兼容测试

- OpenAI SSE；
- Anthropic SSE；
- Dify SSE；
- Coze SSE；
- 普通 JSON 自定义 HTTP Provider；
- WebSocket Provider；
- 未配置 `sse` 的旧 YAML；
- `transform_response` 对普通 JSON 保持原行为。

### 16.5 安全与资源测试

- 超过最大事件数；
- 超过最大响应字节数；
- 超时；
- `timeout_ms` 大于旧默认值时能够支撑长时间心跳流；
- 客户端取消；
- 超大单事件；
- 恶意字段路径；
- 错误消息脱敏；
- HTTPS 证书失败被正确分类，不使用 `verify=False`。
- 拒绝连接、DNS、TLS、connect timeout 和 read timeout 分类互不混淆。

### 16.6 冒烟测试

至少完成：

```bash
python -m pytest agent-scan/pytests/test_sse_parser.py
python -m pytest agent-scan/pytests/test_llm_request.py
python agent-scan/main.py --help
go test ./common/agent ./common/websocket/...
```

使用目标自定义 SSE 样例分别验证：

1. Web 页面“测试联通性”能提取完整文本；
2. Prompt 测试能显示完整文本；
3. 正式 Agent Scan 的 `dialogue` 工具能获得完整回复；
4. 连续发起多次请求行为一致；
5. 增量片段与 completed 全文没有重复。

## 17. 验收标准

### 17.1 功能验收

- [ ] 用户可以仅通过 Provider YAML 接入给定的 `Object/Type/Status/Text` SSE。
- [ ] `:ping` 心跳不会进入回答，也不会导致解析失败。
- [ ] 增量内容与最终全文同时存在时只返回最终全文一次。
- [ ] `Content[0].Text` 可以作为备用最终全文。
- [ ] `Object=response, Status=completed` 可以结束读取。
- [ ] 配置完成规则后，流在命中前断开不会把部分内容交给扫描引擎。
- [ ] `Object=error` 返回明确的上游错误。
- [ ] 新的 `payload.text` 类格式无需修改 Python 即可接入。
- [ ] 普通 JSON Provider 不受影响。

### 17.2 兼容性验收

- [ ] 未配置 `sse` 的已有配置继续工作。
- [ ] OpenAI、Anthropic、Dify 和 Coze 内置 SSE 回归通过。
- [ ] Webserver 联通测试与 Agent 正式扫描解析结果一致。
- [ ] CLI 与 AIG 平台模式使用相同规则。
- [ ] 现有 `transform_response` 的普通 JSON 行为不改变。
- [ ] Provider 的 `timeout_ms` 对 HTTP SSE 联通测试和正式扫描均生效。

### 17.3 安全验收

- [ ] 配置中不存在任意代码执行能力。
- [ ] 事件数、响应大小、字段路径和超时均有硬上限。
- [ ] API Key 和 Authorization Header 不进入错误响应或日志。
- [ ] HTTPS 证书验证默认开启。
- [ ] TLS 验证失败、拒绝连接和超时可以被正确区分。
- [ ] 未知 SSE 配置字段不会被 Pydantic 静默忽略。

### 17.4 工程验收

- [ ] Python 单元测试和入口冒烟通过。
- [ ] 相关 Go 测试通过。
- [ ] Webserver 与 Agent 镜像均包含新实现。
- [ ] 中英文 README 包含配置说明与示例。
- [ ] 不需要进入运行中的容器手工修改源码。

## 18. 实施任务

1. 定义 Pydantic SSE 配置模型和严格校验规则。
2. 实现受限字段路径解析器。
3. 实现标准 SSE 事件解析器，支持事件边界和多行 `data:`。
4. 实现配置规则匹配和内容聚合器。
5. 将 HTTP SSE 请求改为有界增量读取，并让 Provider `timeout_ms` 真正作用于 HTTP/SSE 请求。
6. 接入配置优先、内置回退的解析路由。
7. 完善基于异常链的错误分类和诊断元数据，增加 Usage/Timing 可选映射。
8. 增加目标自定义 SSE、标准 Provider 和异常场景测试。
9. 更新中英文 Provider 配置文档。
10. 恢复临时 `verify=False`，验证企业 CA 的正确接入路径。
11. 构建 Webserver 与 Agent 镜像并完成两条执行链路的冒烟测试。

## 19. 风险与控制

| 风险 | 控制措施 |
|---|---|
| 配置过于复杂 | 第一版只支持相等匹配和受限路径，提供模板示例 |
| 配置错误导致空结果 | 启动/联通测试时校验配置，返回匹配计数和明确错误 |
| 未知配置被静默忽略 | Pydantic SSE 子模型使用 `extra=forbid`，加载阶段失败 |
| 增量与全文重复 | 固定 `completed > fallback_completed > chunks` 优先级 |
| 截断回答被误判为完整回答 | 配置 `done` 时默认 `require_done=true`，未完成不进入扫描引擎 |
| 长连接消耗内存 | 增量读取，不保留完整原始流，设置字节和事件上限 |
| 恶意响应拖延任务 | Read timeout、任务取消和完成事件主动中止 |
| 表达式注入 | 不支持脚本、正则和通用 JSONPath，仅实现安全路径读取 |
| Webserver 与 Agent 行为不一致 | 两个镜像使用相同源码，并分别做冒烟测试 |
| 内置 Provider 回归 | 未配置 `sse` 时保留原逻辑，并增加协议回归测试 |
| TLS 临时绕过进入生产 | OpenSpec 明确禁止，验收要求默认证书验证开启 |
| 错误信息泄密 | 限长、脱敏，不输出 Header、Token 和完整原始事件 |

## 20. 设计决策摘要

本变更采用：

```text
标准 SSE 传输解析
        +
配置化事件映射
        +
内置 Provider 向后兼容
        +
统一 Agent Response
```

不采用只增加一个 `sse_text_path` 字段，因为单一字段无法区分增量、最终全文、结束和错误事件；也不采用任意 JSONPath/脚本表达式，以避免配置注入和不可控复杂度。

该设计使常见的新 SSE 格式能够只通过 Provider YAML 接入，同时保留专用 Adapter 处理极端复杂协议的边界。
