# 去耦喵架构设计

## 产品模型

```text
选中芯片
└─ 多个电源域
   ├─ 可编辑电源标签
   ├─ 0~N 个电源引脚
   ├─ 0~N 个主电容
   └─ 每个引脚 0~N 个去耦电容
```

自动识别只创建初始计划。引脚、电源域、标签和电容配置均可由用户覆盖。

## 数据流

```text
SCH_SelectControl.getAllSelectedPrimitives()
  + SCH_PrimitiveComponent.getAllPinsByPrimitiveId()
  + SCH_ManufactureData.getNetlistFile()
                         │
                         ▼
               GeneratorInput v1
                         │
                         ▼
         POWER 类型 + 名称 + 现有网络名建议
                         │
                         ▼
             用户编辑多电源域生成计划
                         │
                         ▼
       LIB_Device.search() 选择电容器件
                         │
                         ▼
  createNetFlag() + PrimitiveComponent.create()
                         │
                         ▼
             Manifest v1 / 删除与撤销
```

## 初始识别

候选电源引脚满足任一条件：

1. 引脚类型为 `ESCH_PrimitivePinType.POWER`；
2. 名称匹配 VDD、VCC、VDDA、AVDD、DVDD、VBAT、VREF、VCORE等模式。

GND、VSS、AGND等地引脚会从候选中排除。

初始电源标签按以下优先级生成：

1. 引脚已经连接到明确的非自动网络名；
2. 名称包含明确电压，例如 `VDD_3V3` → `+3V3`；
3. 保留原始引脚名，例如 `VDDA` → `VDDA`；
4. 无法推断时使用 `VDD`，等待用户修改。

相同建议标签的候选引脚初始合并为同一电源域。用户可以新增域并重新分配引脚，从而完成拆分或合并。

网表只用于补充现有网络名建议：读取失败、器件未进入网表或尚未分配位号时，仍然使用符号引脚信息继续生成。

## 默认配置

- 每个电源域：`4.7uF × 1` 主电容；
- 每个电源引脚：`100nF × 1` 去耦电容；
- 接地标签：`GND`；
- 电容库器件：首次使用由用户搜索和选择，之后缓存 `{ libraryUuid, uuid }`。

## 创建事务

一次生成包含：

1. 在每个被分配的芯片引脚坐标创建电源标签；
2. 按规划坐标创建电容器件；
3. 写入电容 `Value`；
4. 读取新电容的两个引脚；
5. 在 Pin 1 创建电源标签，在另一个引脚创建 GND 标签；
6. 保存所有新图元 ID。

如果任一步失败，扩展使用已经收集的图元 ID 回滚本次创建内容。

## Manifest v1

```typescript
interface GenerationBatch {
	id: string;
	documentUuid: string;
	chipPrimitiveId: string;
	chipDesignator: string;
	createdAt: string;
	domains: Array<{
		id: string;
		label: string;
		powerLabelIds: string[];
		caps: Array<{
			id: string;
			kind: 'bulk' | 'pin';
			pinNumber: string;
			value: string;
			componentId: string;
			flagIds: string[];
		}>;
	}>;
}
```

删除操作只使用 Manifest 中的图元 ID：

- 删除电容：删除电容器件及其电源/GND标签；
- 删除电源域：删除该域芯片标签和全部电容；
- 撤销整批：删除批次中的全部图元。

不会按名称、坐标或网络猜测并删除用户已有图元。

## 布局策略

- 主电容按电源域在芯片上方的左右侧阵列生成；
- 引脚去耦根据引脚位于芯片中心的左侧或右侧，向外偏移生成；
- 用户可强制统一生成在芯片左侧或右侧；
- 所有坐标使用原理图单位 `0.01 inch`。

首版不创建长导线，使用电源标签和 GND 标签连接，从而减少与已有图形交叉。

## 安全边界

- 扩展没有网络服务或遥测；
- 不读取或删除已有去耦电容；
- 不移动用户图元；
- 只删除 Manifest 记录的自身图元；
- 创建接口失败时尽力回滚；
- 用户仍需检查符号方向、原理图排版和 PCB 物理去耦位置。
