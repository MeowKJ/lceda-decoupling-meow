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
- 电容库器件：通过 `lib_SelectControl.getSelectedLibraryRowInfo()` 读取嘉立创 EDA 底部原生器件库当前选中行，并分别缓存主电容与引脚去耦器件的 `{ libraryUuid, uuid }`。

## 鼠标落位与创建事务

所有已选择电源域作为一个整批事务放置：

1. 预先缓存当前图元 ID，并在用户点击“添加电容”的同步阶段立即调用 `placeComponentWithMouse()`，将整批首个电容黏到鼠标；
2. 记录接口自身创建的跟随鼠标临时图元，轮询新增图元 ID 捕获用户真正点下的锚点电容；
3. 调用客户端 `draw_end` 命令结束重复放置工具，清理临时跟随图元；
4. 以首个落点为整批锚点，将所有已选择电源域按固定行距生成；每域上下母线独立，网络互不相连；
5. 每域主电容排在左侧，逐引脚电容向右排列并写入 `Value`；取消主电容勾选时跳过该域主电容；
6. 用一条水平导线连接本域全部电容上端，并在左侧放置电源标签；
7. 所有电容下端通过竖直支路接入本域连续 GND 母线，每个电源域仅创建一个 GND 标识；
8. 在芯片的所属电源引脚处放置同名电源标签；
9. 重新读取客户端合并后的稳定导线 ID，分别保存器件 ID 和导线 ID。

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
		bankPowerLabelId: string;
		groundFlagId: string;
		groundFlagPoint: { x: number; y: number };
		powerFlagPoint: { x: number; y: number };
		powerLabelIds: string[];
		wireIds: string[];
		caps: Array<{
			id: string;
			kind: 'bulk' | 'pin';
			pinNumber: string;
			value: string;
			componentId: string;
			groundPoint: { x: number; y: number };
			powerPoint: { x: number; y: number };
		}>;
	}>;
}
```

删除操作只使用 Manifest 中的图元 ID：

- 删除电容：删除电容器件，并按剩余电容坐标重建共享电源/GND 母线；删除最后一个电容时一并移除该生成域；
- 删除电源域：删除该域芯片标签和全部电容；
- 撤销整批：删除批次中的全部图元。

不会按名称、坐标或网络猜测并删除用户已有图元。

## 布局策略

- 用户只确定整批的一个锚点，所有已选择电源域按 `100` 坐标单位的固定行距依次向下排列；
- 主电容排在阵列左侧，逐引脚去耦电容依次向右排列；
- 电容统一竖直放置，顶部连接水平电源母线；
- 底部用一条连续 GND 母线连接全部电容，只在母线一端放一个 GND 标识；
- 所有坐标使用原理图单位 `0.01 inch`。

嘉立创 EDA 原理图坐标的较大 Y 值对应屏幕上方；因此电源端选择较大 Y 引脚，GND 端选择较小 Y 引脚。

官方鼠标接口只能预览一个库器件，因此跟随鼠标时显示锚点电容；整组阵列在用户点击后一次完成。

## 安全边界

- 扩展没有网络服务或遥测；
- 不读取或删除已有去耦电容；
- 不移动用户图元；
- 只删除 Manifest 记录的自身图元；
- 创建接口失败时尽力回滚；
- 用户仍需检查符号方向、原理图排版和 PCB 物理去耦位置。
