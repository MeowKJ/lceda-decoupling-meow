/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildGenerationPlan,
	buildInitialDomains,
	isGroundPinName,
	isPowerCandidate,
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

test('builds labels plus bulk and per-pin capacitor placements', () => {
	const input = {
		selected: {
			pins: [pin(1, 'VDD', { x: 100, y: 50 })],
			x: 80,
			y: 50,
		},
	};
	const domains = buildInitialDomains(input.selected.pins);
	const plan = buildGenerationPlan(input, domains, 'right');

	assert.equal(plan.length, 1);
	assert.equal(plan[0].pinLabels.length, 1);
	assert.equal(plan[0].caps.filter(cap => cap.kind === 'bulk').length, 1);
	assert.equal(plan[0].caps.filter(cap => cap.kind === 'pin').length, 1);
	assert.ok(plan[0].caps.every(cap => Number.isFinite(cap.x) && Number.isFinite(cap.y)));
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
