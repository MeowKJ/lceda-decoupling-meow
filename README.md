# 去耦喵（lceda-decoupling-meow）

[![CI](https://github.com/MeowKJ/lceda-decoupling-meow/actions/workflows/ci.yml/badge.svg)](https://github.com/MeowKJ/lceda-decoupling-meow/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

去耦喵是一个面向嘉立创 EDA 专业版 V3 的原理图生成扩展：选中一个芯片后，它会识别多个候选电源域，让用户确认引脚和电源标签，再批量添加主电容与逐引脚去耦电容。

自动识别只是建议。用户可以选择任意引脚、新建或删除电源域、拆分或合并引脚归属，并为每个电源域单独增删电容。

## 功能

- 识别符号类型为 `POWER` 的引脚；
- 补充识别 VDD、VCC、VDDA、VBAT、VREF、AVDD、DVDD、IOVDD、VCORE等常见名称；
- 一个芯片支持多个独立电源域；
- 所有芯片引脚都可手动纳入或移出电源域；
- 每个电源域可选择常用标签或输入自定义标签；
- 默认每个电源域添加一个 `4.7uF` 主电容；
- 默认每个电源引脚添加一个 `100nF` 去耦电容；
- 主电容与逐引脚电容均支持任意添加、删除和修改值；
- 首次使用时搜索并选择一个两引脚电容库器件，后续复用；
- 生成过程失败时自动回滚本次已创建图元；
- 记录去耦喵创建的图元，支持删除单个电容、删除某电源域和撤销整批生成。

## 标签建议原则

去耦喵不会为普通 `VDD` 猜测电压：

- 能读取到明确现有网络名时，优先采用该网络名作为建议；网表不可用时仍可继续生成；
- `VDD_3V3`、`VDD33` 等明确名称可以建议 `+3V3`；
- 普通 `VDD` 仍然建议 `VDD`；
- 用户始终可以覆盖自动建议。

## 安装与使用

### 从源码构建

需要 Node.js 20.17 或更新版本。

```bash
npm install
npm run check
```

生成的扩展包位于：

```text
build/dist/lceda-decoupling-meow_v0.1.0.eext
```

在嘉立创 EDA 专业版 V3 中进入“高级 → 扩展管理器 → 导入”，选择 `.eext` 文件。

### 使用

1. 打开一个原理图图页；
2. 在画布中只选中一个芯片；
3. 选择顶部“去耦喵 → 为选中芯片生成去耦”；
4. 确认候选电源引脚，或者手动选择其他引脚；
5. 新建、拆分或合并电源域，并确认每个电源标签；
6. 为各域增删主电容，为各引脚增删去耦电容；
7. 搜索并选择一个两引脚电容器件；
8. 点击“生成去耦电路”。

生成后，窗口下方会出现管理记录，可以删除单个电容、删除整个电源域或撤销整批生成。

## 生成方式

- 在芯片电源引脚坐标处创建电源标签；
- 在芯片旁生成主电容和逐引脚去耦电容；
- 在电容两端分别创建同名电源标签和 `GND` 标签；
- 不移动芯片，不检查或删除用户已有器件；
- 每次生成独立记录图元 ID，删除操作只作用于去耦喵自己创建的内容。

## 当前限制

- 只处理一个选中芯片；
- 电容值只作为器件 `Value` 写入，不判断容值、耐压和介质是否合理；
- 自动布局是规则化的邻近排布，仍需用户检查并整理原理图版面；
- 生成位置不代表 PCB 去耦电容的最终物理位置；
- 首版使用电源/GND标签完成网络连接，不自动布置长导线；
- 创建和删除接口在官方文档中仍标记为 Beta，建议先在副本工程验证。

详细模型和事务机制见 [docs/architecture.md](./docs/architecture.md)。

## 官方开发依据

- [嘉立创 EDA 扩展 API 开发指南](https://prodocs.lceda.cn/cn/api/guide/)
- [官方 pro-api-sdk](https://github.com/easyeda/pro-api-sdk)
- [官方 EasyEDA API Skill 资料](https://github.com/easyeda/easyeda-api-skill)
- [官方 `.enet` 网表格式](https://github.com/easyeda/easyeda-pro-netlist-format)

本仓库基于官方 `pro-api-sdk` 开发，并在 [NOTICE](./NOTICE) 中保留上游归属。

## 许可证

[Apache License 2.0](./LICENSE)
