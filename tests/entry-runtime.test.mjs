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
});
