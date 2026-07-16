const previewPins = [
	['H18', 'VOUT_PA', 'VOUT_PA'],
	['G17', 'VOUT_PA', 'VOUT_PA'],
	['G16', 'VOUT_PA', 'VOUT_PA'],
	['A9', 'VOUT_14SYNTH', 'VOUT_14SYNTH'],
	['K1', 'VIOIN_18', '+1V8'],
	['F1', 'VIOIN_18', '+1V8'],
	['E1', 'VIOIN_18', '+1V8'],
	['J18', 'VIN_13RF1', 'AR_1P0_RF1'],
	['J17', 'VIN_13RF1', 'AR_1P0_RF1'],
	['J16', 'VIN_13RF1', 'AR_1P0_RF1'],
	['C3', 'VDDIN', 'PMIC_1V2_FILT'],
	['C4', 'VDDIN', 'PMIC_1V2_FILT'],
	['D3', 'VDDIN', 'PMIC_1V2_FILT'],
	['D4', 'VDDIN', 'PMIC_1V2_FILT'],
].map(([number, name, net], index) => ({
	isPowerType: true,
	name,
	net,
	noConnected: false,
	number,
	primitiveId: `pin-${number}`,
	type: 'POWER',
	x: 100 + index * 10,
	y: 200 - index * 5,
}));

const previewInput = {
	collectedAt: new Date().toISOString(),
	document: { tabId: 'preview-tab', uuid: 'preview-document' },
	netlistVersion: 'preview',
	schemaVersion: 1,
	selected: {
		designator: 'U1',
		name: 'IWR6843AOP',
		pins: previewPins,
		primitiveId: 'preview-u1',
		x: 0,
		y: 0,
	},
};

const previewDevices = {
	bulk: {
		footprintName: 'C0603mini',
		libraryUuid: 'preview-library',
		name: 'Cap_0603',
		symbolName: 'Capacitor',
		uuid: 'preview-bulk',
	},
	pin: {
		footprintName: 'C0402',
		libraryUuid: 'preview-library',
		name: 'Cap_0402',
		symbolName: 'Capacitor',
		uuid: 'preview-pin',
	},
};

globalThis.eda = {
	sch_PrimitiveComponent: {
		getAllPrimitiveId: async () => [],
	},
	sys_Storage: {
		deleteExtensionUserConfig: async () => true,
		getExtensionUserConfig(key) {
			if (key === 'decouplingMeow.generatorInput.v1')
				return previewInput;
			if (key === 'decouplingMeow.capacitorDevices.v2')
				return previewDevices;
			return null;
		},
		setExtensionUserConfig: async () => true,
	},
};
