/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildBankPlan,
	buildDomainRowOrigins,
	buildGroundBusPlan,
	buildInitialDomains,
	buildSharedBusPlan,
	extractDeviceCapacitance,
	isGroundPinName,
	isPowerCandidate,
	normalizeCapacitanceValue,
	orderVerticalPinsByRole,
	selectCapacitorTextAttributes,
	selectClosestPlacedComponent,
	shiftCapacitorTextLeft,
	shouldShiftCapacitorAttribute,
	suggestPowerLabel,
	validateDomains,
} from '../iframe/app.mjs';

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

test('moves only capacitor designator and value attributes', () => {
	assert.equal(shouldShiftCapacitorAttribute('Designator'), true);
	assert.equal(shouldShiftCapacitorAttribute('Name'), true);
	assert.equal(shouldShiftCapacitorAttribute('Value'), true);
	assert.equal(shouldShiftCapacitorAttribute('  value  '), true);
	assert.equal(shouldShiftCapacitorAttribute('Supplier Part'), false);
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

test('builds one continuous ground bus with one shared flag point', () => {
	const plan = buildGroundBusPlan([
		{ x: 10, y: 70 },
		{ x: 45, y: 70 },
		{ x: 80, y: 65 },
	]);

	assert.deepEqual(plan.flag, { x: -10, y: 45 });
	assert.deepEqual(plan.bus, [-10, 45, 80, 45]);
	assert.deepEqual(plan.drops, [
		[10, 70, 10, 45],
		[45, 70, 45, 45],
		[80, 65, 80, 45],
	]);
});

test('uses the longest capacitor endpoints for both shared buses', () => {
	const plan = buildSharedBusPlan([
		{ x: 10, powerY: 20, groundY: -20 },
		{ x: 50, powerY: 35, groundY: -35 },
		{ x: 90, powerY: 25, groundY: -25 },
	]);

	assert.deepEqual(plan.power.flag, { x: -10, y: 35 });
	assert.deepEqual(plan.power.bus, [-10, 35, 90, 35]);
	assert.deepEqual(plan.power.drops, [
		[10, 20, 10, 35],
		[90, 25, 90, 35],
	]);
	assert.deepEqual(plan.ground.flag, { x: -10, y: -35 });
	assert.deepEqual(plan.ground.bus, [-10, -35, 90, -35]);
	assert.deepEqual(plan.ground.drops, [
		[10, -20, 10, -35],
		[90, -25, 90, -35],
	]);
});

test('lays every selected power network on its own row from one anchor', () => {
	const domains = [{ label: 'VDD' }, { label: 'VDDA' }, { label: 'VCORE' }];
	const rows = buildDomainRowOrigins(domains, 500, 300);

	assert.deepEqual(rows.map(row => [row.domain.label, row.x, row.y]), [
		['VDD', 500, 300],
		['VDDA', 500, 170],
		['VCORE', 500, 40],
	]);
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
