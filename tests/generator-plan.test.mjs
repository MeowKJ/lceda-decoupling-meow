/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildBankPlan,
	buildDomainRowOrigins,
	buildGroundBusPlan,
	buildInitialDomains,
	isGroundPinName,
	isPowerCandidate,
	orderVerticalPinsByRole,
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

test('lays every selected power network on its own row from one anchor', () => {
	const domains = [{ label: 'VDD' }, { label: 'VDDA' }, { label: 'VCORE' }];
	const rows = buildDomainRowOrigins(domains, 500, 300);

	assert.deepEqual(rows.map(row => [row.domain.label, row.x, row.y]), [
		['VDD', 500, 300],
		['VDDA', 500, 200],
		['VCORE', 500, 100],
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
