/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('invokes mouse placement before asynchronous UI work', async () => {
	const bundle = await readFile(new URL('../dist/iframe.js', import.meta.url), 'utf8');
	const source = await readFile(new URL('../iframe/app.mjs', import.meta.url), 'utf8');
	const placement = bundle.indexOf('placeComponentWithMouse');
	const followTip = bundle.indexOf('showFollowMouseTip', placement);
	const hideWindow = bundle.indexOf('hideIFrame', placement);

	assert.ok(placement >= 0);
	assert.ok(followTip > placement);
	assert.ok(hideWindow > placement);
	assert.match(bundle, /doCommand\(['"]draw_end['"]\)/);
	assert.match(bundle, /getSelectedLibraryRowInfo/);
	assert.match(bundle, /openBottomPanel/);
	assert.match(bundle, /ESYS_BottomPanelTab/);
	assert.match(bundle, /watchNativeDeviceSelection/);
	assert.match(bundle, /useCurrentNativeDevice/);
	assert.match(bundle, /hideIFrame/);
	assert.match(bundle, /capacitorDevices\.v2/);
	assert.match(bundle, /for \(const drop of groundPlan\.drops\)/);
	assert.match(bundle, /placeAllDomainsWithMouse/);
	assert.match(bundle, /totalCaps/);
	assert.match(bundle, /buildSharedBusPlan/);
	assert.match(bundle, /sch_PrimitiveAttribute\.getAll/);
	assert.match(bundle, /gridSize\s*=\s*10/);
	assert.match(bundle, /x:\s*x\s*-\s*gridSize/);
	assert.doesNotMatch(source, /createPowerFlag\(domain\.label, pin\.x, pin\.y\)/);
});
