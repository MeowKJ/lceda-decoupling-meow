/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	allocateCapacitorDesignators,
	areCoordinatesOnGrid,
	buildBankPlan,
	buildInitialDomains,
	buildPersistentPreferences,
	buildSharedBusPlan,
	extractDeviceCapacitance,
	findUnexpectedSelectionIds,
	getExtraPlacementAnchorIds,
	isDrawableWireLine,
	isGroundPinName,
	isPowerCandidate,
	isUniformlyTranslated,
	mapConcurrent,
	matchesLibraryDevice,
	normalizeCapacitanceValue,
	orderVerticalPinsByRole,
	restorePersistentPreferences,
	selectCapacitorTextAttributes,
	selectClosestPlacedComponent,
	shiftCapacitorTextLeft,
	suggestPowerLabel,
	validateDomains,
} from '../iframe/app.mjs';

test('requires every electrical vertex to land on the 0.05 inch schematic grid', () => {
	assert.equal(areCoordinatesOnGrid([0, 5, 10, -15, 20]), true);
	assert.equal(areCoordinatesOnGrid([0, 5, 10.5, 15]), false);
	assert.equal(areCoordinatesOnGrid([0, Number.NaN]), false);
	assert.equal(areCoordinatesOnGrid([0, 10], 0), false);
});

test('persists independent main and bypass device habits in one versioned snapshot', () => {
	const preferences = buildPersistentPreferences({
		bulk: { uuid: 'bulk-device', libraryUuid: 'bulk-library', name: 'Bulk', footprintName: 'C0603' },
		pin: { uuid: 'pin-device', libraryUuid: 'pin-library', name: 'Bypass', footprintName: 'C0402' },
	}, { bulk: '10uF', pin: '220nF' });
	assert.deepEqual(preferences, {
		bulk: {
			device: {
				description: '',
				footprintName: 'C0603',
				libraryUuid: 'bulk-library',
				name: 'Bulk',
				symbolName: '',
				uuid: 'bulk-device',
			},
			value: '10uF',
		},
		pin: {
			device: {
				description: '',
				footprintName: 'C0402',
				libraryUuid: 'pin-library',
				name: 'Bypass',
				symbolName: '',
				uuid: 'pin-device',
			},
			value: '220nF',
		},
		schemaVersion: 1,
	});
});

test('prefers the versioned preference and migrates legacy device/value storage', () => {
	const current = restorePersistentPreferences({
		schemaVersion: 1,
		bulk: { device: { uuid: 'new-bulk', libraryUuid: 'new-library' }, value: '22uF' },
		pin: { device: { uuid: 'new-pin', libraryUuid: 'new-library' }, value: '47nF' },
	}, {
		bulk: { uuid: 'old-bulk', libraryUuid: 'old-library' },
		pin: { uuid: 'old-pin', libraryUuid: 'old-library' },
	}, { bulk: '4.7uF', pin: '100nF' });
	assert.equal(current.devices.bulk.uuid, 'new-bulk');
	assert.equal(current.devices.pin.uuid, 'new-pin');
	assert.deepEqual(current.values, { bulk: '22uF', pin: '47nF' });

	const migrated = restorePersistentPreferences(null, {
		bulk: { uuid: 'old-bulk', libraryUuid: 'old-library' },
		pin: { uuid: 'old-pin', libraryUuid: 'old-library' },
	}, { bulk: '10uF', pin: '220nF' });
	assert.equal(migrated.devices.bulk.uuid, 'old-bulk');
	assert.equal(migrated.devices.pin.uuid, 'old-pin');
	assert.deepEqual(migrated.values, { bulk: '10uF', pin: '220nF' });
});

test('allocates stable capacitor designators after the highest existing C number', () => {
	assert.deepEqual(
		allocateCapacitorDesignators(['R8', 'C97', 'c12', 'C?', undefined], 4),
		['C98', 'C99', 'C100', 'C101'],
	);
});

test('validates one uniform translation for components and polyline wires', () => {
	assert.equal(isUniformlyTranslated([10, 20], [110, -30], 100, -50), true);
	assert.equal(isUniformlyTranslated([10, 20, 30, 40], [110, -30, 130, -10], 100, -50), true);
	assert.equal(isUniformlyTranslated([10, 20, 30, 40], [110, -30, 131, -10], 100, -50), false);
});

function pin(number, name, overrides = {}) {
	return {
		isPowerType: false,
		name,
		net: '',
		number: String(number),
		x: Number(number) * 10,
		y: Number(number) * 5,
		...overrides,
	};
}

test('recognizes POWER typed and conventionally named pins', () => {
	assert.equal(isPowerCandidate(pin(1, 'SUPPLY_A', { isPowerType: true })), true);
	assert.equal(isPowerCandidate(pin(2, 'VDDA')), true);
	assert.equal(isPowerCandidate(pin(6, 'VIN_SRAM')), true);
	assert.equal(isPowerCandidate(pin(7, 'VDDIN')), true);
	assert.equal(isPowerCandidate(pin(8, 'VIOIN_18')), true);
	assert.equal(isPowerCandidate(pin(3, 'GPIO3')), false);
	assert.equal(isGroundPinName('VSSA'), true);
	assert.equal(isPowerCandidate(pin(4, 'VSSA', { isPowerType: true })), false);
	assert.equal(isPowerCandidate(pin(5, 'VDD', { noConnected: true })), false);
});

test('prefers an explicit existing net and never guesses a generic VDD voltage', () => {
	assert.equal(suggestPowerLabel(pin(1, 'VDD', { net: '+3V3' })), '+3V3');
	assert.equal(suggestPowerLabel(pin(2, 'VDD')), 'VDD');
	assert.equal(suggestPowerLabel(pin(3, 'VDD_3V3')), '+3V3');
});

test('creates separate initial domains for different power labels', () => {
	const domains = buildInitialDomains([
		pin(1, 'VDD'),
		pin(2, 'VDD'),
		pin(3, 'VDDA'),
		pin(4, 'GPIO4'),
	]);

	assert.equal(domains.length, 2);
	assert.deepEqual(domains.find(domain => domain.label === 'VDD').pinNumbers, ['1', '2']);
	assert.deepEqual(domains.find(domain => domain.label === 'VDDA').pinNumbers, ['3']);
	assert.equal(domains[0].bulkCaps[0].value, '4.7uF');
});

test('uses persisted global capacitance values for newly recognized domains', () => {
	const [domain] = buildInitialDomains([pin(1, 'VDD')], { bulk: '10uF', pin: '220nF' });
	assert.equal(domain.bulkCaps[0].value, '10uF');
	assert.equal(domain.pinCaps['1'][0].value, '220nF');
});

test('normalizes capacitance values without confusing package numbers', () => {
	assert.equal(normalizeCapacitanceValue('4.7 μF'), '4.7uF');
	assert.equal(normalizeCapacitanceValue('4u7'), '4.7uF');
	assert.equal(normalizeCapacitanceValue('104', true), '100nF');
	assert.equal(normalizeCapacitanceValue('0603', true), '');
});

test('imports capacitance from trusted native device parameters', () => {
	assert.equal(extractDeviceCapacitance({ property: { otherProperty: { Value: '100nF' } } }), '100nF');
	assert.equal(extractDeviceCapacitance({ property: { otherProperty: { 容量: '4.7uF' } } }), '4.7uF');
	assert.equal(extractDeviceCapacitance({ attributes: { Capacitance: '104' } }), '100nF');
	assert.equal(extractDeviceCapacitance({ name: 'Cap_0603', description: 'C0603mini' }), '');
	assert.equal(extractDeviceCapacitance({ description: 'MLCC 10uF 10V X5R' }), '10uF');
});

test('matches the settled anchor by nearest placement coordinate after draw_end', () => {
	const component = (id, x, y) => ({
		getState_PrimitiveId: () => id,
		getState_X: () => x,
		getState_Y: () => y,
	});
	const far = component('new-far', 500, 500);
	const closest = component('new-anchor', 102, 198);
	assert.equal(selectClosestPlacedComponent([far, closest], { x: 100, y: 200 }), closest);
});

test('accepts only the selected native library device as a placement anchor', () => {
	const device = { libraryUuid: 'library-a', uuid: 'device-a' };
	const matching = { getState_Component: () => ({ libraryUuid: 'library-a', uuid: 'device-a' }) };
	const other = { getState_Component: () => ({ libraryUuid: 'library-b', uuid: 'device-b' }) };

	assert.equal(matchesLibraryDevice(matching, device), true);
	assert.equal(matchesLibraryDevice(other, device), false);
	assert.equal(matchesLibraryDevice({}, device), false);
});

test('keeps one settled anchor and marks repeated mouse placements for cleanup', () => {
	const components = ['C97', 'C98', 'C99'].map(id => ({
		getState_PrimitiveId: () => id,
	}));

	assert.deepEqual(getExtraPlacementAnchorIds(components, 'C97'), ['C98', 'C99']);
});

test('blocks whole-group movement when selection expands to existing page primitives', () => {
	assert.deepEqual(
		findUnexpectedSelectionIds(['cap-1', 'wire-1', 'existing-gnd'], ['cap-1', 'wire-1']),
		['existing-gnd'],
	);
});

test('orders bulk capacitors before per-pin capacitors in a connected bank', () => {
	const [domain] = buildInitialDomains([pin(1, 'VDD'), pin(2, 'VDD')]);
	const plan = buildBankPlan(domain);

	assert.equal(plan.length, 3);
	assert.equal(plan[0].kind, 'bulk');
	assert.deepEqual(plan.slice(1).map(cap => cap.pinNumber), ['1', '2']);
});

test('quick bulk checkbox can exclude the main capacitor without deleting its setup', () => {
	const [domain] = buildInitialDomains([pin(1, 'VDD')]);
	domain.bulkEnabled = false;
	const plan = buildBankPlan(domain);

	assert.equal(plan.length, 1);
	assert.equal(plan[0].kind, 'pin');
	assert.equal(domain.bulkCaps[0].value, '4.7uF');
});

test('maps larger EasyEDA Y to the visual power side', () => {
	const lowY = { getState_Y: () => -20 };
	const highY = { getState_Y: () => 20 };
	const roles = orderVerticalPinsByRole([highY, lowY]);

	assert.equal(roles.powerPin, highY);
	assert.equal(roles.groundPin, lowY);
});

function attribute(id, key, value, x, visible = true) {
	return {
		getState_Key: () => key,
		getState_PrimitiveId: () => id,
		getState_Value: () => value,
		getState_ValueVisible: () => visible,
		getState_X: () => x,
	};
}

test('selects one visible designator and one displayed capacitor value', () => {
	const attributes = [
		attribute('designator', 'Designator', 'C1', 100),
		attribute('name', 'Name', '={Value}', 100),
		attribute('value-hidden', 'Value', '100nF', 100, false),
		attribute('device-name', 'Name', 'Capacitor', 100),
	];
	assert.deepEqual(
		selectCapacitorTextAttributes(attributes, '100nF').map(item => item.getState_PrimitiveId()),
		['designator', 'name'],
	);
});

test('verifies capacitor text movement through the attribute API', async () => {
	const previousEda = globalThis.eda;
	const moves = [];
	const attributes = [
		attribute('designator', 'Designator', 'C1', 100),
		attribute('name', 'Name', '={Value}', 120),
		attribute('bad-coordinate', 'Value', '100nF', undefined),
	];
	globalThis.eda = {
		sch_PrimitiveAttribute: {
			get: async () => undefined,
			getAll: async () => attributes,
			modify: async (id, property) => {
				moves.push([id, property.x]);
				return attribute(id, id === 'designator' ? 'Designator' : 'Name', '', property.x);
			},
		},
	};
	try {
		assert.equal(await shiftCapacitorTextLeft('C1', '100nF'), 2);
		assert.deepEqual(moves, [['designator', 90], ['name', 110]]);
	}
	finally {
		globalThis.eda = previousEda;
	}
});

test('fails generation when the attribute move is not applied', async () => {
	const previousEda = globalThis.eda;
	globalThis.eda = {
		sch_PrimitiveAttribute: {
			get: async () => undefined,
			getAll: async () => [attribute('designator', 'Designator', 'C1', 100)],
			modify: async () => undefined,
		},
	};
	try {
		await assert.rejects(() => shiftCapacitorTextLeft('C1', '100nF'), /移动电容文字 Designator 失败/);
	}
	finally {
		globalThis.eda = previousEda;
	}
});

test('puts both labels above and below the first capacitor', () => {
	const plan = buildSharedBusPlan([
		{ x: 10, powerY: 20, groundY: -20 },
		{ x: 50, powerY: 35, groundY: -35 },
		{ x: 90, powerY: 25, groundY: -25 },
	]);

	assert.deepEqual(plan.power.flag, { x: 10, y: 35 });
	assert.deepEqual(plan.power.bus, [10, 35, 90, 35]);
	assert.deepEqual(plan.power.drops, [
		[10, 20, 10, 35],
		[90, 25, 90, 35],
	]);
	assert.deepEqual(plan.ground.flag, { x: 10, y: -35 });
	assert.deepEqual(plan.ground.bus, [10, -35, 90, -35]);
	assert.deepEqual(plan.ground.drops, [
		[10, -20, 10, -35],
		[90, -25, 90, -35],
	]);
});

test('runs placement work concurrently while preserving result order', async () => {
	let active = 0;
	let maximum = 0;
	const results = await mapConcurrent([10, 20, 30, 40], 2, async (value) => {
		active += 1;
		maximum = Math.max(maximum, active);
		await new Promise(resolve => setTimeout(resolve, 2));
		active -= 1;
		return value / 10;
	});
	assert.deepEqual(results, [1, 2, 3, 4]);
	assert.equal(maximum, 2);
});

test('waits for started placement work to settle before reporting a failure', async () => {
	const events = [];
	await assert.rejects(() => mapConcurrent([1, 2, 3], 2, async (value) => {
		events.push(`start-${value}`);
		if (value === 1)
			throw new Error('placement failed');
		await new Promise(resolve => setTimeout(resolve, 4));
		events.push(`finish-${value}`);
		return value;
	}), /placement failed/);
	assert.deepEqual(events, ['start-1', 'start-2', 'finish-2']);
});

test('uses each pin X coordinate when a capacitor symbol is not perfectly vertical', () => {
	const plan = buildSharedBusPlan([
		{ powerX: 10, groundX: 12, powerY: 20, groundY: -20 },
		{ powerX: 50, groundX: 54, powerY: 30, groundY: -30 },
	]);

	assert.deepEqual(plan.power.flag, { x: 10, y: 30 });
	assert.deepEqual(plan.power.drops, [[10, 20, 10, 30]]);
	assert.deepEqual(plan.ground.flag, { x: 12, y: -30 });
	assert.deepEqual(plan.ground.drops, [[12, -20, 12, -30]]);
});

test('skips zero-length buses for a one-capacitor power domain', () => {
	const plan = buildSharedBusPlan([
		{ powerX: 10, groundX: 10, powerY: 20, groundY: -20 },
	]);

	assert.equal(isDrawableWireLine(plan.power.bus), false);
	assert.equal(isDrawableWireLine(plan.ground.bus), false);
	assert.deepEqual(plan.power.drops, []);
	assert.deepEqual(plan.ground.drops, []);
	assert.equal(isDrawableWireLine([10, 20, 40, 20]), true);
});

test('validates empty labels and unassigned domains', () => {
	const errors = validateDomains([{
		bulkCaps: [],
		label: '',
		pinCaps: {},
		pinNumbers: [],
	}]);
	assert.equal(errors.length, 2);
});
