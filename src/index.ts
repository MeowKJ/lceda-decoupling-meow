/**
 * 去耦喵扩展入口。
 *
 * Based on the JLCEDA pro-api-sdk and modified for lceda-decoupling-meow.
 * This entry only collects the selected component and opens the generator UI.
 */
import * as extensionConfig from '../extension.json';

const INPUT_STORAGE_KEY = 'decouplingMeow.generatorInput.v1';
const IFRAME_ID = 'lceda-decoupling-meow-window';
const CONTEXT_MENU_HOOK_KEY = '__lcedaDecouplingMeowContextMenuHook';
const CONTEXT_MENU_TIMER_KEY = '__lcedaDecouplingMeowContextMenuTimer';
const CONTEXT_MENU_COMMAND = `runRegisteredExtensionFn(${extensionConfig.uuid}.generateForSelectedComponent)`;
const CONTEXT_MENU_TITLE = '去耦喵';
const CONTEXT_MENU_GENERATE_TITLE = '生成去耦';
const CONTEXT_MENU_RETRY_MS = 1000;

interface SchematicContextMenuState {
	cmdKey?: string;
	selectedIds?: Array<string>;
	target?: string | Array<string>;
}

interface RawContextMenuItem {
	cmd?: string;
	icon?: string;
	submenu?: Array<RawContextMenuItem | string | null>;
	text?: string;
}

interface RawContextMenuData {
	part?: Array<RawContextMenuItem | string | null>;
	[key: string]: unknown;
}

type InternalPublish = (topic: string, message: unknown, ...args: Array<unknown>) => unknown;
type InternalRpcReply = (result: unknown, replyTopic: string, ...args: Array<unknown>) => unknown;

interface InternalMessageBus {
	publish: InternalPublish;
	rpcReply: InternalRpcReply;
	[key: string]: unknown;
}

interface ContextMenuHookState {
	originalPublish: InternalPublish;
	originalRpcReply: InternalRpcReply;
	version: string;
}

interface ContextMenuTimerState {
	timer: ReturnType<typeof setInterval>;
	version: string;
}

interface SchematicRuntime {
	SCH?: {
		gVars?: {
			messageBus?: InternalMessageBus;
		};
	};
	[CONTEXT_MENU_TIMER_KEY]?: ContextMenuTimerState;
}

interface EnetPin {
	name?: string;
	net?: string;
	number?: string;
	props?: Record<string, string>;
}

interface EnetComponent {
	pinInfoMap?: Record<string, EnetPin>;
	props?: Record<string, string>;
}

interface EnetFile {
	components?: Record<string, EnetComponent>;
	version?: string;
}

interface GeneratorPin {
	isPowerType: boolean;
	name: string;
	net: string;
	noConnected: boolean;
	number: string;
	primitiveId: string;
	type: string;
	x: number;
	y: number;
}

interface GeneratorInput {
	collectedAt: string;
	document: {
		tabId: string;
		uuid: string;
	};
	netlistVersion: string;
	schemaVersion: 1;
	selected: {
		designator: string;
		name: string;
		pins: Array<GeneratorPin>;
		primitiveId: string;
		x: number;
		y: number;
	};
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	void status;
	void arg;
	installSchematicContextMenuHook();
	const runtime = globalThis as unknown as SchematicRuntime;
	const existingTimer = runtime[CONTEXT_MENU_TIMER_KEY];
	if (existingTimer?.version !== extensionConfig.version) {
		if (existingTimer)
			clearInterval(existingTimer.timer);
		runtime[CONTEXT_MENU_TIMER_KEY] = {
			timer: setInterval(() => {
				installSchematicContextMenuHook();
			}, CONTEXT_MENU_RETRY_MS),
			version: extensionConfig.version,
		};
	}
}

export function deactivate(): void {
	const runtime = globalThis as unknown as SchematicRuntime;
	const timerState = runtime[CONTEXT_MENU_TIMER_KEY];
	if (timerState?.version === extensionConfig.version) {
		clearInterval(timerState.timer);
		delete runtime[CONTEXT_MENU_TIMER_KEY];
	}
}

function isSingleSchematicComponentContext(context: SchematicContextMenuState | undefined): boolean {
	const target = Array.isArray(context?.target) ? context.target[0] : context?.target;
	return (context?.cmdKey === 'part' || target === 'part')
		&& context?.selectedIds?.length === 1;
}

export function appendDecouplingContextMenu(
	menuData: RawContextMenuData | undefined,
	context: SchematicContextMenuState | undefined,
): RawContextMenuData | undefined {
	if (!menuData || !isSingleSchematicComponentContext(context) || !Array.isArray(menuData.part))
		return menuData;
	if (menuData.part.some(item => typeof item === 'object' && item?.text === CONTEXT_MENU_TITLE))
		return menuData;

	const part = [...menuData.part];
	const extensionItem = {
		icon: 'eda-component',
		submenu: [{
			cmd: CONTEXT_MENU_COMMAND,
			icon: 'eda-component',
			text: CONTEXT_MENU_GENERATE_TITLE,
		}],
		text: CONTEXT_MENU_TITLE,
	};
	const firstSeparator = part.indexOf('menu-sep');
	if (firstSeparator >= 0)
		part.splice(firstSeparator + 1, 0, extensionItem, 'menu-sep');
	else
		part.unshift(extensionItem, 'menu-sep');
	return { ...menuData, part };
}

export function installSchematicContextMenuHook(): boolean {
	const runtime = globalThis as unknown as SchematicRuntime;
	const bus = runtime.SCH?.gVars?.messageBus;
	if (!bus || typeof bus.publish !== 'function' || typeof bus.rpcReply !== 'function')
		return false;

	const hookRecord = bus as unknown as Record<string, unknown>;
	const existing = hookRecord[CONTEXT_MENU_HOOK_KEY] as ContextMenuHookState | undefined;
	if (existing?.version === extensionConfig.version)
		return true;
	if (existing) {
		bus.publish = existing.originalPublish;
		bus.rpcReply = existing.originalRpcReply;
	}

	let latestContext: SchematicContextMenuState | undefined;
	const originalPublish = bus.publish;
	const originalRpcReply = bus.rpcReply;
	bus.publish = function (topic, message, ...args) {
		if (topic === 'showEditorContextMenu') {
			latestContext = Array.isArray(message)
				? message[0] as SchematicContextMenuState
				: message as SchematicContextMenuState;
		}
		return originalPublish.call(this, topic, message, ...args);
	};
	bus.rpcReply = function (result, replyTopic, ...args) {
		const nextResult = String(replyTopic).includes('menuData')
			? appendDecouplingContextMenu(result as RawContextMenuData, latestContext)
			: result;
		return originalRpcReply.call(this, nextResult, replyTopic, ...args);
	};
	hookRecord[CONTEXT_MENU_HOOK_KEY] = {
		originalPublish,
		originalRpcReply,
		version: extensionConfig.version,
	} satisfies ContextMenuHookState;
	return true;
}

function findEnetComponent(netlist: EnetFile, designator: string): EnetComponent | undefined {
	const target = designator.trim().toUpperCase();
	return Object.values(netlist.components ?? {}).find((component) => {
		return String(component.props?.Designator ?? '').trim().toUpperCase() === target;
	});
}

async function getSelectedComponent(): Promise<ISCH_PrimitiveComponent> {
	const selected = await eda.sch_SelectControl.getAllSelectedPrimitives();
	const components = selected.filter((primitive) => {
		return primitive.getState_PrimitiveType() === ESCH_PrimitiveType.COMPONENT;
	}) as Array<ISCH_PrimitiveComponent>;

	if (components.length === 0) {
		throw new Error('请先在当前原理图中选中一个芯片。');
	}
	if (components.length > 1) {
		throw new Error('一次只能处理一个芯片，请只保留一个器件处于选中状态。');
	}

	return components[0];
}

async function collectGeneratorInput(): Promise<GeneratorInput> {
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!document || document.documentType !== EDMT_EditorDocumentType.SCHEMATIC_PAGE) {
		throw new Error('请先打开并激活一个原理图图页。');
	}

	const component = await getSelectedComponent();
	const primitiveId = component.getState_PrimitiveId();
	const rawDesignator = component.getState_Designator() ?? '';
	const designator = rawDesignator || component.getState_Name() || '未编号器件';
	const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);

	let netlist: EnetFile = {};
	try {
		const netlistFile = await eda.sch_ManufactureData.getNetlistFile();
		if (netlistFile) {
			netlist = JSON.parse(await netlistFile.text()) as EnetFile;
		}
	}
	catch {
		// Existing net names improve label suggestions, but generation does not depend on a netlist.
	}

	const enetComponent = rawDesignator ? findEnetComponent(netlist, rawDesignator) : undefined;
	const enetPins = new Map(
		Object.values(enetComponent?.pinInfoMap ?? {}).map(pin => [
			String(pin.number ?? pin.props?.['Pin Number'] ?? ''),
			pin,
		]),
	);

	const generatorPins: Array<GeneratorPin> = (pins ?? []).map((pin) => {
		const number = pin.getState_PinNumber();
		const enetPin = enetPins.get(number);
		return {
			isPowerType: pin.getState_pinType() === ESCH_PrimitivePinType.POWER,
			name: pin.getState_PinName() || enetPin?.name || '',
			net: enetPin?.net ?? '',
			noConnected: pin.getState_NoConnected(),
			number,
			primitiveId: pin.getState_PrimitiveId(),
			type: pin.getState_pinType(),
			x: pin.getState_X(),
			y: pin.getState_Y(),
		};
	});

	return {
		collectedAt: new Date().toISOString(),
		document: {
			tabId: document.tabId,
			uuid: document.uuid,
		},
		netlistVersion: netlist.version ?? '',
		schemaVersion: 1,
		selected: {
			designator,
			name: component.getState_Name() ?? component.getState_Component()?.name ?? '',
			pins: generatorPins,
			primitiveId,
			x: component.getState_X(),
			y: component.getState_Y(),
		},
	};
}

export async function generateForSelectedComponent(): Promise<void> {
	try {
		const input = await collectGeneratorInput();
		await eda.sys_Storage.setExtensionUserConfig(INPUT_STORAGE_KEY, input);
		const opened = await eda.sys_IFrame.openIFrame('/iframe/index.html', 800, 540, IFRAME_ID, {
			grayscaleMask: false,
			maximizeButton: true,
			minimizeButton: true,
			minimizeStyle: 'collapsed',
			title: `去耦喵 · ${input.selected.designator}`,
		});

		if (!opened) {
			await eda.sys_Storage.deleteExtensionUserConfig(INPUT_STORAGE_KEY);
			throw new Error('无法打开去耦生成窗口。');
		}
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		eda.sys_Dialog.showInformationMessage(message, '去耦喵');
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		`去耦喵 v${extensionConfig.version}\n\n识别选中芯片的多个电源域，将电容、标签与连接母线作为完整图元组随鼠标整块放置，不修改芯片本体或已有去耦。`,
		'关于去耦喵',
	);
}
