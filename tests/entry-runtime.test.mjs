/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('opens the generator when the selected component is absent from the netlist', async () => {
	const calls = {
		dialogs: [],
		opened: [],
		stored: [],
	};
	const pin = {
		getState_NoConnected: () => false,
		getState_PinName: () => 'VDD',
		getState_PinNumber: () => '1',
		getState_PrimitiveId: () => 'pin-1',
		getState_X: () => 120,
		getState_Y: () => 80,
		getState_pinType: () => 'POWER',
	};
	const component = {
		getState_Component: () => ({ name: 'Demo MCU' }),
		getState_Designator: () => 'U1',
		getState_Name: () => 'Demo MCU',
		getState_PrimitiveId: () => 'component-1',
		getState_PrimitiveType: () => 'COMPONENT',
		getState_X: () => 100,
		getState_Y: () => 80,
	};
	const eda = {
		dmt_SelectControl: {
			getCurrentDocumentInfo: async () => ({ documentType: 'SCHEMATIC_PAGE', tabId: 'tab-1', uuid: 'doc-1' }),
		},
		sch_ManufactureData: {
			getNetlistFile: async () => ({ text: async () => JSON.stringify({ components: {} }) }),
		},
		sch_PrimitiveComponent: {
			getAllPinsByPrimitiveId: async () => [pin],
		},
		sch_SelectControl: {
			getAllSelectedPrimitives: async () => [component],
		},
		sys_Dialog: {
			showInformationMessage: message => calls.dialogs.push(message),
		},
		sys_IFrame: {
			openIFrame: async (...args) => {
				calls.opened.push(args);
				return true;
			},
		},
		sys_Storage: {
			deleteExtensionUserConfig: async () => true,
			setExtensionUserConfig: async (...args) => {
				calls.stored.push(args);
				return true;
			},
		},
	};
	const bundle = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
	const extension = vm.runInNewContext(`${bundle}\nedaEsbuildExportName`, {
		EDA: {},
		EDMT_EditorDocumentType: { SCHEMATIC_PAGE: 'SCHEMATIC_PAGE' },
		ESCH_PrimitivePinType: { POWER: 'POWER' },
		ESCH_PrimitiveType: { COMPONENT: 'COMPONENT' },
		eda,
	});

	await extension.generateForSelectedComponent();

	assert.deepEqual(calls.dialogs, []);
	assert.equal(calls.stored.length, 1);
	assert.equal(calls.stored[0][1].selected.pins[0].name, 'VDD');
	assert.equal(calls.opened.length, 1);
	assert.equal(calls.opened[0][0], '/iframe/index.html');
	assert.equal(calls.opened[0][1], 800);
	assert.equal(calls.opened[0][2], 540);
});

test('adds one native schematic context-menu action for a single component', async () => {
	const replies = [];
	const bus = {
		publish: () => true,
		rpcReply: (...args) => replies.push(args),
	};
	const bundle = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
	const extension = vm.runInNewContext(`${bundle}\nedaEsbuildExportName`, {
		EDA: {},
		SCH: { gVars: { messageBus: bus } },
		setInterval: () => 1,
	});

	assert.equal(extension.installSchematicContextMenuHook(), true);
	bus.publish('showEditorContextMenu', [{ cmdKey: 'part', selectedIds: ['U1'], target: ['part'] }]);
	bus.rpcReply({ part: [{ cmd: 'copy', text: 'Copy' }, 'menu-sep', { cmd: 'delete', text: 'Delete' }] }, '_MSG_BUS_RPC_-menuData-test');

	const menu = replies[0][0].part;
	const itemIndex = menu.findIndex(item => typeof item === 'object' && item?.text === '原理图自动去耦喵');
	assert.equal(itemIndex, 2);
	assert.equal(menu[itemIndex].submenu[0].text, '生成去耦');
	assert.equal(menu[itemIndex].submenu[0].cmd, 'runRegisteredExtensionFn(7f342549d32b4cbca363f63d3b5b734d.generateForSelectedComponent)');
	assert.equal(menu[itemIndex + 1], 'menu-sep');
	bus.publish('showEditorContextMenu', [{ cmdKey: 'wire', selectedIds: ['wire-1'], target: ['wire'] }]);
	bus.rpcReply({ wire: [{ cmd: 'copy', text: 'Copy' }] }, '_MSG_BUS_RPC_-menuData-wire');
	assert.deepEqual(replies[1][0].wire, [{ cmd: 'copy', text: 'Copy' }]);
	bus.publish('showEditorContextMenu', [{ cmdKey: 'part', selectedIds: ['U1', 'U2'], target: ['part'] }]);
	bus.rpcReply({ part: [{ cmd: 'copy', text: 'Copy' }] }, '_MSG_BUS_RPC_-menuData-multiple');
	assert.equal(replies[2][0].part.length, 1);
	assert.equal(extension.installSchematicContextMenuHook(), true);
});
