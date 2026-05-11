
Now I need to write a script that generates a docx file with data entity tables for each sub-heading in the document. Let me analyze the document structure:
**6 物联管控平台** (main heading, no entity table needed)
- (1) 设备连接与管理
  - ①设备注册
  - ②设备认证
- (2) 数据采集与存储
  - ①数据采集协议
  - ②数据存储与管理
- (3) 远程监测与控制
  - ①实时数据展示
  - ②远程控制功能
- (4) 告警与异常处理
  - ①告警设置与管理
  - ②异常处理与故障排查
- (5) 扩展与集成接口
  - ①设备接入接口
  - ②开放API
  - ③第三方应用支持

**7 电子签章服务**
- (1) 签章服务
  - ①基本功能
  - ②自主可控
  - ③制章管理
  - ④印章发放
  - ⑤印章信息管理
  - ⑥印章吊销
  - ⑦印章销毁
  - ⑧验章服务
  - ⑨密码算法
- (2) 签章客户端
  - ①版式软件支持
  - ②支持USB签章Key

**8 校园轻应用**
- (1) 账号注册与管理
- (2) 账号密码登录
- (3) 短信验证码登录
- (4) 第三方账号登录
- (5) 单点登录
- (6) 安全策略与风险控制
- (7) 忘记密码与账号恢复
- (8) 学术资源与教学
- (9) 信息交互与通知
- (10) 资源预约与借用

The user wants data entity tables for each sub-heading. I think "子标题" here refers to the (1), (2), (3)... level sub-headings. For each one, I need to generate a data entity table that describes the data entities involved.

Let me think about what "数据实体表" means. It's a data entity table - typically a table describing the entities (database tables) that would be needed to support the functionality described in each sub-heading. Each entity table would have columns like:
- 序号 (sequence number)
- 实体名称 (entity name)
- 实体描述 (entity description)
- 主要属性 (main attributes/fields)

For each sub-heading, I'll generate entity tables based on the functional requirements described.

Let me create the script. This is going to be a large script given the number of sub-headings (17 in total).

Actually, looking more carefully at the structure, the "子标题" could mean:
1. The (1), (2), (3)... numbered items (17 total)
2. The ①, ②, ③... sub-items under each numbered item

I think the user means the (1), (2), (3)... level - those are the main sub-sections. For each of those, I'll create a data entity table.

Let me design the entity tables:

### 6 物联管控平台

**(1) 设备连接与管理**
Entities: 设备信息表, 设备注册记录表, 设备认证记录表

**(2) 数据采集与存储**
Entities: 数据采集任务表, 采集协议配置表, 设备数据表, 数据存储配置表

**(3) 远程监测与控制**
Entities: 实时数据展示表, 远程控制指令表, 控制操作记录表

**(4) 告警与异常处理**
Entities: 告警规则表, 告警记录表, 故障处理记录表

**(5) 扩展与集成接口**
Entities: 设备接入配置表, API接口配置表, 第三方应用配置表, 接口调用日志表

### 7 电子签章服务

**(1) 签章服务**
Entities: 电子印章表, 制章申请表, 印章发放记录表, 印章吊销记录表, 印章销毁记录表, 签章验证记录表, 密码算法配置表

**(2) 签章客户端**
Entities: 客户端配置表, USB Key信息表, 版式文件签章记录表

### 8 校园轻应用

**(1) 账号注册与管理** - 用户账号表, 账号类型表, 身份认证信息表
**(2) 账号密码登录** - 登录记录表, 密码策略表
**(3) 短信验证码登录** - 短信验证码表
**(4) 第三方账号登录** - 第三方账号绑定表
**(5) 单点登录** - SSO会话表, 应用系统关联表
**(6) 安全策略与风险控制** - 安全策略表, 登录失败记录表, 异常行为记录表
**(7) 忘记密码与账号恢复** - 密码重置记录表
**(8) 学术资源与教学** - 学术资源表, 资源分类表, 用户收藏表, 订阅记录表
**(9) 信息交互与通知** - 消息推送表, 消息模板表, 消息记录表
**(10) 资源预约与借用** - 资源信息表, 预约申请表, 预约审批表, 归还记录表, 使用评价表

This is a big script. Let me write it now. I'll use docx-js to create the document with proper formatting.

For each entity table, I'll create a table with columns:
- 序号
- 实体名称
- 实体描述
- 主要属性

Each table will be preceded by the sub-heading title.

Let me write the script now. I need to be careful with the docx-js API based on the skill instructions.docx 库安装成功。现在我需要编写一个 Node.js 脚本来生成数据实体表文档。

根据文档内容，我需要为每个子标题创建对应的数据实体表。让我分析文档结构：

**6 物联管控平台**
1. 设备连接与管理
   - 设备注册
   - 设备认证
2. 数据采集与存储
   - 数据采集协议
   - 数据存储与管理
3. 远程监测与控制
   - 实时数据展示
   - 远程控制功能
4. 告警与异常处理
   - 告警设置与管理
   - 异常处理与故障排查
5. 扩展与集成接口
   - 设备接入接口
   - 开放API
   - 第三方应用支持

**7 电子签章服务**
1. 签章服务
   - 基本功能
   - 自主可控
   - 制章管理
   - 印章发放
   - 印章信息管理
   - 印章吊销
   - 印章销毁
   - 验章服务
   - 密码算法
2. 签章客户端
   - 版式软件支持
   - 支持USB签章Key

**8 校园轻应用**
1. 账号注册与管理
2. 账号密码登录
3. 短信验证码登录
4. 第三方账号登录
5. 单点登录
6. 安全策略与风险控制
7. 忘记密码与账号恢复
8. 学术资源与教学
9. 信息交互与通知
10. 资源预约与借用

用户要求"每个子标题均生成对应数据实体表"，意思是为每个子标题设计一个数据实体表，包含该功能模块涉及的主要数据字段。

我需要为每个子标题设计合理的数据实体，包含字段名、字段类型、是否必填、说明等列。

让我开始编写脚本。这个脚本会比较长，我需要仔细设计每个实体表的字段。

首先，让我设计实体表的结构：

对于每个子标题，我会创建一个表格，包含以下列：
- 序号
- 字段名（英文）
- 字段中文名
- 数据类型
- 是否必填
- 说明

然后为每个子标题设计合理的字段。

让我开始编写脚本...Good, docx is installed. Now I need to create a comprehensive script that generates data entity tables for each sub-heading in the document. Let me analyze the document structure:

**6 物联管控平台** (IoT Management Platform)
- (1) 设备连接与管理 → Device Connection & Management
  - ① 设备注册 → Device Registration
  - ② 设备认证 → Device Authentication
- (2) 数据采集与存储 → Data Collection & Storage
  - ① 数据采集协议 → Data Collection Protocol
  - ② 数据存储与管理 → Data Storage & Management
- (3) 远程监测与控制 → Remote Monitoring & Control
  - ① 实时数据展示 → Real-time Data Display
  - ② 远程控制功能 → Remote Control Functions
- (4) 告警与异常处理 → Alert & Exception Handling
  - ① 告警设置与管理 → Alert Configuration & Management
  - ② 异常处理与故障排查 → Exception Handling & Troubleshooting
- (5) 扩展与集成接口 → Extension & Integration Interfaces
  - ① 设备接入接口 → Device Access Interface
  - ② 开放API → Open API
  - ③ 第三方应用支持 → Third-party Application Support

**7 电子签章服务** (Electronic Seal Service)
- (1) 签章服务 → Seal Service
  - ① 基本功能 → Basic Functions
  - ② 自主可控 → Autonomous Controllable
  - ③ 制章管理 → Seal Creation Management
  - ④ 印章发放 → Seal Distribution
  - ⑤ 印章信息管理 → Seal Information Management
  - ⑥ 印章吊销 → Seal Revocation
  - ⑦ 印章销毁 → Seal Destruction
  - ⑧ 验章服务 → Seal Verification Service
  - ⑨ 密码算法 → Cryptographic Algorithm
- (2) 签章客户端 → Seal Client
  - ① 版式软件支持 → Layout Software Support
  - ② 支持USB签章Key → USB Seal Key Support

**8 校园轻应用** (Campus Lightweight Apps)
- (1) 账号注册与管理 → Account Registration & Management
- (2) 账号密码登录 → Account Password Login
- (3) 短信验证码登录 → SMS Verification Code Login
- (4) 第三方账号登录 → Third-party Account Login
- (5) 单点登录 → Single Sign-on
- (6) 安全策略与风险控制 → Security Policy & Risk Control
- (7) 忘记密码与账号恢复 → Forgot Password & Account Recovery
- (8) 学术资源与教学 → Academic Resources & Teaching
- (9) 信息交互与通知 → Information Interaction & Notification
- (10) 资源预约与借用 → Resource Reservation & Borrowing

Wait, I need to reconsider what "数据实体表" means. The user wants me to generate data entity tables for each sub-heading. This likely means database entity tables - i.e., for each functional module/sub-heading, I need to design the corresponding database entity (table) with fields like: field name, data type, length, whether nullable, default value, description, etc.

Let me think about what entities each sub-heading would need:

For **(1) 设备连接与管理**, the entity could be:
- Device (设备) - device_id, device_name, device_type, device_status, manufacturer, model, serial_number, firmware_version, registration_time, authentication_status, gateway_id, location, etc.

For **① 设备注册**:
- Device_Registration (设备注册) - registration_id, device_id, registration_time, operator, status, verification_result, etc.

For **② 设备认证**:
- Device_Authentication (设备认证) - auth_id, device_id, auth_type, auth_key, auth_status, auth_time, expiry_time, etc.

And so on for each sub-heading.

This is a very large document with many sub-headings. Let me create a comprehensive script.

Actually, looking at this more carefully, each sub-heading (①②③...) represents a specific function, and each main heading ((1)(2)(3)...) is a module. The user wants data entity tables for each sub-heading.

Let me design the entities carefully based on the requirements described in each sub-heading.

I'll create a comprehensive Node.js script that generates a Word document with entity tables for all sub-headings.

Let me think about the structure of each entity table. A typical data entity table in Chinese software documentation includes:

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |

For each sub-heading, I need to create:
1. A heading for the entity
2. A table describing the entity's fields

Let me plan the entities:

**6.物联管控平台**

**(1) 设备连接与管理**
① 设备注册 → Entity: IoT_Device (物联网设备表)
- id: 主键ID, bigint, NOT NULL, AUTO_INCREMENT
- device_code: 设备编码, varchar, 64, NOT NULL
- device_name: 设备名称, varchar, 128, NOT NULL
- device_type: 设备类型, varchar, 64, NOT NULL (门禁/监控/传感器等)
- manufacturer: 生产厂商, varchar, 128, NULL
- model: 设备型号, varchar, 64, NULL
- serial_number: 序列号, varchar, 128, NULL
- firmware_version: 固件版本, varchar, 32, NULL
- gateway_id: 网关ID, bigint, NULL
- location: 安装位置, varchar, 256, NULL
- register_time: 注册时间, datetime, NOT NULL
- register_by: 注册人, varchar, 64, NULL
- status: 设备状态, tinyint, NOT NULL, 0 (0-未激活/1-在线/2-离线/3-故障)
- create_time: 创建时间, datetime, NOT NULL
- update_time: 更新时间, datetime, NOT NULL

② 设备认证 → Entity: Device_Authentication (设备认证表)
- id: 主键ID, bigint, NOT NULL
- device_id: 设备ID, bigint, NOT NULL
- auth_type: 认证方式, varchar, 32, NOT NULL (证书/密钥/Token)
- auth_key: 认证密钥, varchar, 256, NOT NULL
- cert_info: 证书信息, text, NULL
- auth_status: 认证状态, tinyint, NOT NULL, 0
- auth_time: 认证时间, datetime, NULL
- expire_time: 过期时间, datetime, NULL
- retry_count: 重试次数, int, NOT NULL, 0
- last_auth_time: 最后认证时间, datetime, NULL
- create_time: 创建时间, datetime, NOT NULL
- update_time: 更新时间, datetime, NOT NULL

OK this is going to be very long. Let me create the script with all entities defined in a structured way.

Actually, let me reconsider. This is a lot of entities (about 17+ sub-headings, each with its own entity table). I should create a comprehensive data structure and then generate the document from it.

Let me write the full script now. I'll define each entity with its fields and generate the document.

Let me carefully define each entity:

**6 物联管控平台**

**6.1 设备连接与管理**
- Entity: IoT_Device (物联网设备表)

**6.1.1 设备注册** - The device registration process is captured in IoT_Device table itself, with registration-related fields.

Actually, I think the user wants me to create entity tables for each sub-heading (①②③ level). Let me re-examine:

The structure is:
- 6 物联管控平台 (Level 1 - module)
  - (1) 设备连接与管理 (Level 2 - sub-module)
    - ① 设备注册 (Level 3 - function)
    - ② 设备认证 (Level 3 - function)

So "子标题" likely refers to the (1)(2)(3) level sub-headings (not the ①②③ level). That would give us:
- 6.1 设备连接与管理
- 6.2 数据采集与存储
- 6.3 远程监测与控制
- 6.4 告警与异常处理
- 6.5 扩展与集成接口
- 7.1 签章服务
- 7.2 签章客户端
- 8.1 账号注册与管理
- 8.2 账号密码登录
- 8.3 短信验证码登录
- 8.4 第三方账号登录
- 8.5 单点登录
- 8.6 安全策略与风险控制
- 8.7 忘记密码与账号恢复
- 8.8 学术资源与教学
- 8.9 信息交互与通知
- 8.10 资源预约与借用

That's 17 sub-headings. Each gets one data entity table.

Actually, thinking again - "每个子标题" could also mean each (1)(2)(3) level AND each ①②③ level. But typically in database design, we'd create entities at the (1)(2)(3) level. Some ①②③ items might share the same entity (e.g., 设备注册 and 设备认证 both relate to the Device entity).

I think the most practical approach is to create entity tables at the (1)(2)(3) level, where each sub-module gets its primary entity/entities. But some sub-headings at the ①②③ level would have their own entities too.

Let me go with creating entities at the (1)(2)(3) level primarily, but also consider ①②③ where they represent distinct data concepts.

Actually, let me re-read the request: "将里面每个子标题均生成对应数据实体表". "每个子标题" - each sub-title. The sub-titles in the document are the items marked with (1), (2), (3)... and their sub-items ①, ②, ③...

I think the most reasonable interpretation is the main sub-headings (1)(2)(3) level, as these are the primary functional modules. Let me generate entity tables for all 17 of these.

Let me now write the comprehensive script. This will be a large file but I'll organize it well.

For each entity, I need to think about what data fields are relevant based on the functional requirements described.

Let me define all entities:

**6.1 设备连接与管理 → IoT_Device (物联网设备表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 设备编码 | device_code | varchar | 64 | 是 | - | 唯一编码 |
| 3 | 设备名称 | device_name | varchar | 128 | 是 | - | - |
| 4 | 设备类型 | device_type | tinyint | - | 是 | - | 1-门禁/2-监控/3-传感器/4-网关/5-其他 |
| 5 | 生产厂商 | manufacturer | varchar | 128 | 否 | - | - |
| 6 | 设备型号 | model | varchar | 64 | 否 | - | - |
| 7 | 序列号 | serial_number | varchar | 128 | 否 | - | - |
| 8 | 固件版本 | firmware_version | varchar | 32 | 否 | - | - |
| 9 | 关联网关ID | gateway_id | bigint | - | 否 | - | 关联IoT_Device表 |
| 10 | 安装位置 | location | varchar | 256 | 否 | - | - |
| 11 | 认证方式 | auth_type | tinyint | - | 否 | - | 1-证书/2-密钥/3-Token |
| 12 | 认证密钥 | auth_key | varchar | 256 | 否 | - | 加密存储 |
| 13 | 认证状态 | auth_status | tinyint | - | 是 | 0 | 0-未认证/1-已认证/2-认证失败 |
| 14 | 设备状态 | status | tinyint | - | 是 | 0 | 0-未激活/1-在线/2-离线/3-故障 |
| 15 | 注册时间 | register_time | datetime | - | 否 | - | - |
| 16 | 注册人 | register_by | varchar | 64 | 否 | - | - |
| 17 | 最后上线时间 | last_online_time | datetime | - | 否 | - | - |
| 18 | 备注 | remark | varchar | 512 | 否 | - | - |
| 19 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 20 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**6.2 数据采集与存储 → Device_Data_Record (设备数据采集记录表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 设备ID | device_id | bigint | - | 是 | - | 关联IoT_Device表 |
| 3 | 采集协议 | protocol | tinyint | - | 是 | - | 1-MQTT/2-CoAP/3-HTTP/4-Modbus/5-其他 |
| 4 | 数据类型 | data_type | varchar | 64 | 是 | - | 温度/湿度/图像/视频等 |
| 5 | 采集数据 | data_content | text | - | 是 | - | 采集到的原始数据(JSON) |
| 6 | 数据单位 | data_unit | varchar | 16 | 否 | - | ℃/%/Pa等 |
| 7 | 采集时间 | collect_time | datetime | - | 是 | - | 设备采集时间 |
| 8 | 接收时间 | receive_time | datetime | - | 是 | CURRENT_TIMESTAMP | 平台接收时间 |
| 9 | 数据质量 | quality | tinyint | - | 否 | 1 | 0-异常/1-正常 |
| 10 | 存储策略 | storage_policy | tinyint | - | 否 | 1 | 1-实时/2-归档/3-压缩 |
| 11 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**6.3 远程监测与控制 → Device_Control_Record (设备远程控制记录表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 设备ID | device_id | bigint | - | 是 | - | 关联IoT_Device表 |
| 3 | 控制命令 | command_code | varchar | 64 | 是 | - | 命令编码 |
| 4 | 控制类型 | control_type | tinyint | - | 是 | - | 1-开关/2-参数调整/3-重启/4-升级 |
| 5 | 命令参数 | command_params | text | - | 否 | - | JSON格式参数 |
| 6 | 执行结果 | result | tinyint | - | 是 | 0 | 0-待执行/1-成功/2-失败/3-超时 |
| 7 | 返回数据 | response_data | text | - | 否 | - | 设备返回数据 |
| 8 | 操作人 | operator | varchar | 64 | 是 | - | - |
| 9 | 操作时间 | operate_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 10 | 完成时间 | complete_time | datetime | - | 否 | - | - |
| 11 | 错误信息 | error_msg | varchar | 512 | 否 | - | - |
| 12 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**6.4 告警与异常处理 → Device_Alarm (设备告警记录表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 设备ID | device_id | bigint | - | 是 | - | 关联IoT_Device表 |
| 3 | 告警规则ID | rule_id | bigint | - | 是 | - | 关联告警规则表 |
| 4 | 告警级别 | alarm_level | tinyint | - | 是 | - | 1-提示/2-警告/3-严重/4-紧急 |
| 5 | 告警类型 | alarm_type | varchar | 64 | 是 | - | 离线/阈值超限/故障等 |
| 6 | 告警内容 | alarm_content | varchar | 512 | 是 | - | - |
| 7 | 触发值 | trigger_value | varchar | 64 | 否 | - | 触发告警的实际值 |
| 8 | 阈值 | threshold_value | varchar | 64 | 否 | - | 设定的告警阈值 |
| 9 | 告警状态 | alarm_status | tinyint | - | 是 | 0 | 0-未处理/1-处理中/2-已处理/3-已忽略 |
| 10 | 处理人 | handler | varchar | 64 | 否 | - | - |
| 11 | 处理意见 | handle_opinion | varchar | 512 | 否 | - | - |
| 12 | 处理时间 | handle_time | datetime | - | 否 | - | - |
| 13 | 故障原因 | fault_reason | varchar | 512 | 否 | - | - |
| 14 | 解决方案 | solution | varchar | 1024 | 否 | - | - |
| 15 | 告警时间 | alarm_time | datetime | - | 是 | - | - |
| 16 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 17 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**6.5 扩展与集成接口 → Integration_API_Config (集成接口配置表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 接口编码 | api_code | varchar | 64 | 是 | - | 唯一编码 |
| 3 | 接口名称 | api_name | varchar | 128 | 是 | - | - |
| 4 | 接口类型 | api_type | tinyint | - | 是 | - | 1-设备接入/2-开放API/3-第三方集成 |
| 5 | 接口地址 | api_url | varchar | 256 | 是 | - | - |
| 6 | 请求方式 | request_method | varchar | 16 | 是 | - | GET/POST/PUT/DELETE |
| 7 | 认证方式 | auth_type | tinyint | - | 否 | 1 | 1-无/2-API Key/3-OAuth2/4-Token |
| 8 | 接口描述 | description | varchar | 512 | 否 | - | - |
| 9 | 接口状态 | status | tinyint | - | 是 | 1 | 0-禁用/1-启用 |
| 10 | 限流策略 | rate_limit | int | - | 否 | - | 每分钟最大调用次数 |
| 11 | 版本号 | version | varchar | 16 | 否 | 1.0 | - |
| 12 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 13 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**7.1 签章服务 → Seal_Info (电子印章信息表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 印章编码 | seal_code | varchar | 64 | 是 | - | 唯一编码 |
| 3 | 印章名称 | seal_name | varchar | 128 | 是 | - | - |
| 4 | 印章类型 | seal_type | tinyint | - | 是 | - | 1-单位签章/2-个人签章 |
| 5 | 所属单位/人员 | owner_name | varchar | 128 | 是 | - | - |
| 6 | 所属ID | owner_id | bigint | - | 是 | - | 关联单位或人员ID |
| 7 | 印章图片 | seal_image | varchar | 512 | 否 | - | 印章图片存储路径 |
| 8 | 密码算法 | crypto_algorithm | varchar | 64 | 否 | - | 使用的密码算法 |
| 9 | 证书信息 | cert_info | text | - | 否 | - | 关联的数字证书 |
| 10 | 制章申请人 | apply_user | varchar | 64 | 是 | - | - |
| 11 | 制章审批人 | approve_user | varchar | 64 | 否 | - | - |
| 12 | 制章时间 | create_seal_time | datetime | - | 否 | - | - |
| 13 | 发放时间 | distribute_time | datetime | - | 否 | - | - |
| 14 | 生效时间 | effective_time | datetime | - | 否 | - | - |
| 15 | 失效时间 | expire_time | datetime | - | 否 | - | - |
| 16 | 印章状态 | status | tinyint | - | 是 | 0 | 0-待审批/1-已制章/2-已发放/3-已吊销/4-已销毁 |
| 17 | 吊销原因 | revoke_reason | varchar | 512 | 否 | - | - |
| 18 | 吊销时间 | revoke_time | datetime | - | 否 | - | - |
| 19 | 销毁时间 | destroy_time | datetime | - | 否 | - | - |
| 20 | 备注 | remark | varchar | 512 | 否 | - | - |
| 21 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 22 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**7.2 签章客户端 → Seal_Operation_Record (签章操作记录表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 印章ID | seal_id | bigint | - | 是 | - | 关联Seal_Info表 |
| 3 | 文档ID | document_id | varchar | 128 | 是 | - | 被签章的文档标识 |
| 4 | 文档名称 | document_name | varchar | 256 | 是 | - | - |
| 5 | 操作类型 | operation_type | tinyint | - | 是 | - | 1-盖章/2-验章 |
| 6 | 操作模式 | operation_mode | tinyint | - | 是 | - | 1-在线/2-离线 |
| 7 | 操作结果 | result | tinyint | - | 是 | - | 0-失败/1-成功 |
| 8 | 验章结果 | verify_result | tinyint | - | 否 | - | 0-未验证/1-通过/2-不通过/3-已篡改 |
| 9 | USB Key标识 | usb_key_id | varchar | 128 | 否 | - | USB签章Key序列号 |
| 10 | 版式软件 | software_name | varchar | 64 | 否 | - | 使用的版式软件 |
| 11 | 操作人 | operator | varchar | 64 | 是 | - | - |
| 12 | 操作时间 | operate_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 13 | 错误信息 | error_msg | varchar | 512 | 否 | - | - |
| 14 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**8.1 账号注册与管理 → User_Account (用户账号表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 用户标识 | user_code | varchar | 64 | 是 | - | 唯一标识 |
| 3 | 用户名 | username | varchar | 64 | 是 | - | - |
| 4 | 密码 | password | varchar | 256 | 是 | - | 加密存储 |
| 5 | 手机号 | mobile | varchar | 20 | 否 | - | - |
| 6 | 邮箱 | email | varchar | 128 | 否 | - | - |
| 7 | 用户类型 | user_type | tinyint | - | 是 | - | 1-学员/2-教员/3-后勤人员/4-管理员 |
| 8 | 内网身份ID | internal_id | varchar | 64 | 否 | - | 内网身份认证同步 |
| 9 | 头像 | avatar | varchar | 512 | 否 | - | - |
| 10 | 账号状态 | status | tinyint | - | 是 | 1 | 0-禁用/1-正常/2-锁定 |
| 11 | 锁定原因 | lock_reason | varchar | 256 | 否 | - | - |
| 12 | 锁定时间 | lock_time | datetime | - | 否 | - | - |
| 13 | 最后登录时间 | last_login_time | datetime | - | 否 | - | - |
| 14 | 注册来源 | register_source | tinyint | - | 否 | 1 | 1-小程序/2-内网导入 |
| 15 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 16 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**8.2 账号密码登录 → Login_Log (登录日志表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 用户ID | user_id | bigint | - | 是 | - | 关联User_Account表 |
| 3 | 登录方式 | login_type | tinyint | - | 是 | - | 1-密码/2-短信/3-微信/4-QQ/5-单点 |
| 4 | 登录结果 | result | tinyint | - | 是 | - | 0-失败/1-成功 |
| 5 | 登录IP | login_ip | varchar | 64 | 否 | - | - |
| 6 | 设备信息 | device_info | varchar | 256 | 否 | - | - |
| 7 | 失败原因 | fail_reason | varchar | 256 | 否 | - | - |
| 8 | 会话ID | session_id | varchar | 128 | 否 | - | - |
| 9 | 登录时间 | login_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 10 | 登出时间 | logout_time | datetime | - | 否 | - | - |
| 11 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**8.3 短信验证码登录 → SMS_Verification (短信验证码表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 手机号 | mobile | varchar | 20 | 是 | - | - |
| 3 | 验证码 | verify_code | varchar | 8 | 是 | - | - |
| 4 | 业务类型 | biz_type | tinyint | - | 是 | - | 1-登录/2-注册/3-重置密码 |
| 5 | 发送状态 | send_status | tinyint | - | 是 | 0 | 0-发送中/1-成功/2-失败 |
| 6 | 验证状态 | verify_status | tinyint | - | 是 | 0 | 0-未验证/1-验证通过/2-验证失败 |
| 7 | 已用次数 | used_count | int | - | 是 | 0 | 防止暴力破解 |
| 8 | 错误次数 | error_count | int | - | 是 | 0 | 连续错误次数 |
| 9 | 过期时间 | expire_time | datetime | - | 是 | - | - |
| 10 | IP地址 | ip_address | varchar | 64 | 否 | - | - |
| 11 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**8.4 第三方账号登录 → Third_Party_Binding (第三方账号绑定表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 用户ID | user_id | bigint | - | 是 | - | 关联User_Account表 |
| 3 | 第三方平台 | platform | tinyint | - | 是 | - | 1-微信/2-QQ/3-其他 |
| 4 | 第三方用户ID | third_party_id | varchar | 128 | 是 | - | 第三方平台的用户ID |
| 5 | 第三方用户名 | third_party_name | varchar | 128 | 否 | - | - |
| 6 | 授权令牌 | access_token | varchar | 512 | 否 | - | 加密存储 |
| 7 | 刷新令牌 | refresh_token | varchar | 512 | 否 | - | 加密存储 |
| 8 | 令牌过期时间 | token_expire_time | datetime | - | 否 | - | - |
| 9 | 授权范围 | scope | varchar | 256 | 否 | - | 授权的权限范围 |
| 10 | 绑定状态 | status | tinyint | - | 是 | 1 | 0-已解绑/1-已绑定 |
| 11 | 绑定时间 | bind_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 12 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 13 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**8.5 单点登录 → SSO_Session (单点登录会话表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 用户ID | user_id | bigint | - | 是 | - | 关联User_Account表 |
| 3 | 会话令牌 | session_token | varchar | 256 | 是 | - | 全局会话标识 |
| 4 | 关联系统 | system_code | varchar | 64 | 是 | - | 接入的子系统编码 |
| 5 | 系统会话ID | system_session_id | varchar | 256 | 否 | - | 子系统本地会话 |
| 6 | 登录IP | login_ip | varchar | 64 | 否 | - | - |
| 7 | 会话状态 | status | tinyint | - | 是 | 1 | 0-已注销/1-活跃/2-过期 |
| 8 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 9 | 过期时间 | expire_time | datetime | - | 是 | - | - |
| 10 | 注销时间 | logout_time | datetime | - | 否 | - | - |

**8.6 安全策略与风险控制 → Security_Policy (安全策略配置表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 策略编码 | policy_code | varchar | 64 | 是 | - | 唯一编码 |
| 3 | 策略名称 | policy_name | varchar | 128 | 是 | - | - |
| 4 | 策略类型 | policy_type | tinyint | - | 是 | - | 1-密码策略/2-登录策略/3-异常检测 |
| 5 | 策略规则 | policy_rule | text | - | 是 | - | JSON格式规则配置 |
| 6 | 密码加密算法 | encrypt_algorithm | varchar | 64 | 否 | - | 如SM4/AES-256 |
| 7 | 最大失败次数 | max_fail_count | int | - | 否 | 5 | 连续登录失败锁定阈值 |
| 8 | 锁定时长(分钟) | lock_duration | int | - | 否 | 30 | - |
| 9 | 策略状态 | status | tinyint | - | 是 | 1 | 0-禁用/1-启用 |
| 10 | 适用范围 | apply_scope | varchar | 256 | 否 | - | 适用用户类型(JSON) |
| 11 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 12 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**8.7 忘记密码与账号恢复 → Password_Reset (密码重置记录表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 用户ID | user_id | bigint | - | 是 | - | 关联User_Account表 |
| 3 | 重置方式 | reset_type | tinyint | - | 是 | - | 1-手机验证码/2-邮箱验证码/3-管理员重置 |
| 4 | 重置验证码 | verify_code | varchar | 64 | 否 | - | 加密存储 |
| 5 | 验证目标 | verify_target | varchar | 128 | 是 | - | 手机号或邮箱 |
| 6 | 重置状态 | status | tinyint | - | 是 | 0 | 0-待验证/1-已验证/2-已完成/3-已过期 |
| 7 | 重置令牌 | reset_token | varchar | 256 | 否 | - | 一次性重置令牌 |
| 8 | 过期时间 | expire_time | datetime | - | 是 | - | - |
| 9 | 操作IP | ip_address | varchar | 64 | 否 | - | - |
| 10 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 11 | 完成时间 | complete_time | datetime | - | 否 | - | - |

**8.8 学术资源与教学 → Academic_Resource (学术资源表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 资源编码 | resource_code | varchar | 64 | 是 | - | 唯一编码 |
| 3 | 资源标题 | title | varchar | 256 | 是 | - | - |
| 4 | 资源类型 | resource_type | tinyint | - | 是 | - | 1-期刊/2-论文/3-会议/4-教材/5-其他 |
| 5 | 作者 | author | varchar | 256 | 否 | - | - |
| 6 | 来源/期刊名 | source | varchar | 256 | 否 | - | - |
| 7 | 摘要 | abstract | text | - | 否 | - | - |
| 8 | 关键词 | keywords | varchar | 512 | 否 | - | 逗号分隔 |
| 9 | 资源文件路径 | file_path | varchar | 512 | 否 | - | - |
| 10 | 文件大小(bytes) | file_size | bigint | - | 否 | - | - |
| 11 | 下载次数 | download_count | int | - | 是 | 0 | - |
| 12 | 浏览次数 | view_count | int | - | 是 | 0 | - |
| 13 | 发布日期 | publish_date | date | - | 否 | - | - |
| 14 | 来源库 | source_db | varchar | 64 | 否 | - | 对接的学术库 |
| 15 | 资源状态 | status | tinyint | - | 是 | 1 | 0-下架/1-上架 |
| 16 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 17 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**8.9 信息交互与通知 → Notification (消息通知表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 消息标题 | title | varchar | 256 | 是 | - | - |
| 3 | 消息内容 | content | text | - | 是 | - | - |
| 4 | 消息类型 | msg_type | tinyint | - | 是 | - | 1-系统通知/2-课程安排/3-考试安排/4-监控安排/5-学术更新/6-维修进度/7-其他 |
| 5 | 接收人ID | receiver_id | bigint | - | 否 | - | 为null表示全员推送 |
| 6 | 接收人类型 | receiver_type | tinyint | - | 否 | - | 1-学员/2-教员/3-后勤/4-全员 |
| 7 | 发布人 | publisher | varchar | 64 | 是 | - | - |
| 8 | 发布时间 | publish_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 9 | 阅读状态 | read_status | tinyint | - | 是 | 0 | 0-未读/1-已读 |
| 10 | 阅读时间 | read_time | datetime | - | 否 | - | - |
| 11 | 是否订阅类 | is_subscription | tinyint | - | 否 | 0 | 0-否/1-是 |
| 12 | 关联资源ID | related_resource_id | bigint | - | 否 | - | 学术资源订阅关联 |
| 13 | 消息状态 | status | tinyint | - | 是 | 1 | 0-撤回/1-正常 |
| 14 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 15 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

**8.10 资源预约与借用 → Resource_Reservation (资源预约借用表)**

| 序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注 |
|------|--------|----------|----------|------|----------|--------|------|
| 1 | 主键ID | id | bigint | - | 是 | 自增 | 主键 |
| 2 | 资源ID | resource_id | bigint | - | 是 | - | 关联资源基础信息表 |
| 3 | 资源名称 | resource_name | varchar | 128 | 是 | - | - |
| 4 | 资源类型 | resource_type | tinyint | - | 是 | - | 1-教室/2-会议室/3-实验室/4-其他 |
| 5 | 资源位置 | location | varchar | 256 | 否 | - | - |
| 6 | 预约人ID | user_id | bigint | - | 是 | - | - |
| 7 | 预约人姓名 | user_name | varchar | 64 | 是 | - | - |
| 8 | 联系方式 | contact | varchar | 64 | 是 | - | - |
| 9 | 预约目的 | purpose | varchar | 256 | 是 | - | - |
| 10 | 预约开始时间 | start_time | datetime | - | 是 | - | - |
| 11 | 预约结束时间 | end_time | datetime | - | 是 | - | - |
| 12 | 预计时长(小时) | duration | decimal | 5,1 | 否 | - | - |
| 13 | 审批状态 | approval_status | tinyint | - | 是 | 0 | 0-待审批/1-已通过/2-已拒绝 |
| 14 | 审批人 | approver | varchar | 64 | 否 | - | - |
| 15 | 审批时间 | approval_time | datetime | - | 否 | - | - |
| 16 | 审批意见 | approval_opinion | varchar | 512 | 否 | - | - |
| 17 | 归还状态 | return_status | tinyint | - | 是 | 0 | 0-未归还/1-已归还 |
| 18 | 归还时间 | return_time | datetime | - | 否 | - | - |
| 19 | 使用评价 | evaluation | varchar | 512 | 否 | - | - |
| 20 | 评价分数 | score | tinyint | - | 否 | - | 1-5分 |
| 21 | 预约状态 | status | tinyint | - | 是 | 1 | 0-已取消/1-有效/2-已完成 |
| 22 | 创建时间 | create_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |
| 23 | 更新时间 | update_time | datetime | - | 是 | CURRENT_TIMESTAMP | - |

OK, that's all 17 entities defined. Now let me write the Node.js script to generate this document.

This is going to be a very long script. Let me write it efficiently.

Actually, I need to also add an alert rule entity for 6.4. Let me add that.

Actually, let me keep it focused - each sub-heading gets ONE primary entity table. The alert rules can be referenced as a separate entity or I can note it. Let me keep it to one entity per sub-heading for clarity.

Now let me write the script. I need to be careful with the docx-js API based on the skill instructions.

Key points from the skill:
- Always use WidthType.DXA
- Table width must equal sum of columnWidths
- Cell width must match corresponding columnWidth
- Use ShadingType.CLEAR (not SOLID) for header shading
- Use A4 page size (11906 x 16838)
- Content width with 1 inch margins: 9026 DXA
- Actually for Chinese documents, maybe larger margins? Let me use standard margins.

For the entity table columns:
序号 | 字段名 | 字段编码 | 数据类型 | 长度 | 是否必填 | 默认值 | 备注

That's 8 columns. Content width = 9026 DXA for A4 with 1 inch margins.

Let me calculate column widths:
- 序号: ~600
- 字段名: ~1400
- 字段编码: ~1600
- 数据类型: ~1000
- 长度: ~700
- 是否必填: ~800
- 默认值: ~1000
- 备注: ~1926

Total: 600 + 1400 + 1600 + 1000 + 700 + 800 + 1000 + 1926 = 9026 ✓

Let me write the script now. I'll structure it as:
1. Define all entities in a data structure
2. Generate the document with headings and tables

Let me write this as a single comprehensive script file.Good, docx is installed. Now let me write the script to generate the data entity tables. Let me plan the entities based on the document structure:

**6 物联管控平台:**
1. 设备连接与管理 → 设备注册信息表, 设备认证信息表
2. 数据采集与存储 → 数据采集记录表, 数据存储管理表
3. 远程监测与控制 → 实时数据展示表, 远程控制记录表
4. 告警与异常处理 → 告警规则表, 异常处理记录表
5. 扩展与集成接口 → 设备接入接口表, 开放API配置表, 第三方应用表

**7 电子签章服务:**
1. 签章服务 → 电子印章表, 印章发放记录表, 印章状态表, 验章记录表, 密码算法配置表
2. 签章客户端 → 签章操作记录表, USB Key信息表

Actually, let me think about this more carefully. The user wants data entity tables for each sub-title. So for each (1), (2), (3)... numbered section, I should create a table that defines the data entities (fields) relevant to that section.

Let me design entities more carefully for each sub-section:

**6 物联管控平台:**

(1) 设备连接与管理 → 物联设备信息表
- 设备ID, 设备名称, 设备类型, 设备编号, 设备状态, 注册时间, 认证状态, 认证密钥, 所属网关ID, 安装位置, 创建时间, 更新时间

(2) 数据采集与存储 → 数据采集记录表
- 采集ID, 设备ID, 采集协议, 采集数据, 数据类型, 采集时间, 存储状态, 数据质量, 创建时间

(3) 远程监测与控制 → 远程控制记录表
- 控制ID, 设备ID, 控制指令, 控制参数, 操作人员, 操作时间, 执行状态, 返回结果, 创建时间

(4) 告警与异常处理 → 告警规则表 + 告警记录表
- 告警规则: 规则ID, 设备类型, 告警类型, 阈值条件, 告警级别, 通知方式, 状态, 创建时间
- 异常处理记录: 记录ID, 告警ID, 设备ID, 异常描述, 处理人员, 处理方案, 处理时间, 处理状态

(5) 扩展与集成接口 → 接口配置表
- 接口ID, 接口名称, 接口类型, 接口地址, 认证方式, 请求协议, 状态, 创建时间

Actually, let me reconsider. The user wants "每个子标题均生成对应数据实体表". I think this means for each numbered sub-title like (1) 设备连接与管理, generate a data entity table. Each entity table should have columns like: 字段名, 字段类型, 是否必填, 说明.

Let me create comprehensive entity tables for each sub-section. I'll generate a well-structured docx file.

Let me write a comprehensive script. Given the document has 3 major sections with sub-sections, I'll create entity tables for each sub-section.

Let me organize:

**6 物联管控平台:**
- (1) 设备连接与管理 → 物联设备信息表, 设备认证信息表
- (2) 数据采集与存储 → 数据采集记录表, 数据存储管理表  
- (3) 远程监测与控制 → 实时监测数据表, 远程控制指令表
- (4) 告警与异常处理 → 告警规则配置表, 告警记录表, 故障处理记录表
- (5) 扩展与集成接口 → 接口配置表, 第三方应用注册表

**7 电子签章服务:**
- (1) 签章服务 → 电子印章信息表, 印章发放记录表, 印章验章记录表, 密码算法配置表
- (2) 签章客户端 → 签章操作记录表, USB Key信息表

**8 校园轻应用:**
- (1) 账号注册与管理 → 用户账号信息表
- (2) 账号密码登录 → 登录记录表
- (3) 短信验证码登录 → 短信验证码记录表
- (4) 第三方账号登录 → 第三方账号绑定表
- (5) 单点登录 → 单点登录会话表
- (6) 安全策略与风险控制 → 安全策略配置表, 账号异常记录表
- (7) 忘记密码与账号恢复 → 密码重置记录表
- (8) 学术资源与教学 → 学术资源信息表, 资源订阅记录表
- (9) 信息交互与通知 → 消息推送记录表, 订阅收藏表, 信息发布表
- (10) 资源预约与借用 → 资源信息表, 预约申请表, 资源借用记录表

Actually, some of these can be combined. Let me be more practical and create one or two main entity tables per sub-section, focusing on the key entities.

Let me write the script now.Good, docx is installed. Now let me write the script to generate the entity tables document. I need to create entity tables for each sub-heading in the document. Let me analyze the structure:

**6 物联管控平台**
- (1) 设备连接与管理 → Entity: Device, DeviceAuth
  - ① 设备注册 → Device (device_id, device_name, device_type, registration_time, status, ...)
  - ② 设备认证 → DeviceAuth (auth_id, device_id, auth_key, auth_status, ...)
- (2) 数据采集与存储 → Entity: DataCollection, DataStorage
  - ① 数据采集协议 → DataCollectionProtocol (protocol_id, protocol_name, ...)
  - ② 数据存储与管理 → DataStorage (storage_id, device_id, data_type, ...)
- (3) 远程监测与控制 → Entity: RemoteMonitor, RemoteControl
  - ① 实时数据展示 → RealtimeData (data_id, device_id, metric_name, value, timestamp, ...)
  - ② 远程控制功能 → RemoteControl (control_id, device_id, command, ...)
- (4) 告警与异常处理 → Entity: Alert, FaultRecord
  - ① 告警设置与管理 → AlertRule (rule_id, device_id, threshold, ...)
  - ② 异常处理与故障排查 → FaultRecord (fault_id, device_id, description, ...)
- (5) 扩展与集成接口 → Entity: DeviceInterface, OpenAPI, ThirdPartyApp
  - ① 设备接入接口 → DeviceInterface (interface_id, interface_name, ...)
  - ② 开放API → OpenAPI (api_id, api_name, ...)
  - ③ 第三方应用支持 → ThirdPartyApp (app_id, app_name, ...)

**7 电子签章服务**
- (1) 签章服务
  - ① 基本功能 → Seal (seal_id, seal_type, ...)
  - ② 自主可控 → PlatformCompatibility (platform_id, os_type, processor_type, ...)
  - ③ 制章管理 → SealCreation (creation_id, seal_name, applicant, ...)
  - ④ 印章发放 → SealDistribution (distribution_id, seal_id, receiver, ...)
  - ⑤ 印章信息管理 → SealInfo (seal_info_id, seal_id, attributes, ...)
  - ⑥ 印章吊销 → SealRevocation (revocation_id, seal_id, ...)
  - ⑦ 印章销毁 → SealDestruction (destruction_id, seal_id, ...)
  - ⑧ 验章服务 → SealVerification (verification_id, seal_id, ...)
  - ⑨ 密码算法 → CryptoAlgorithm (algorithm_id, algorithm_name, ...)
- (2) 签章客户端
  - ① 版式软件支持 → FormatSoftwareIntegration (integration_id, software_name, ...)
  - ② 支持USB签章Key → USBKey (key_id, key_serial, ...)

**8 校园轻应用**
- (1) 账号注册与管理 → User, UserProfile
- (2) 账号密码登录 → LoginLog, AuthCredential
- (3) 短信验证码登录 → SMSVerification
- (4) 第三方账号登录 → ThirdPartyBinding
- (5) 单点登录 → SSOSession
- (6) 安全策略与风险控制 → SecurityPolicy, LoginAttempt
- (7) 忘记密码与账号恢复 → PasswordReset
- (8) 学术资源与教学 → AcademicResource
- (9) 信息交互与通知 → Notification, Message
- (10) 资源预约与借用 → Resource, Reservation

OK, let me create a comprehensive script. Each entity table should have fields like:
- Field Name (字段名)
- Field Type (字段类型)
- Is Required (是否必填)
- Description (描述)

Let me write a thorough script.