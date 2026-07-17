const INPUT_STORAGE_KEY = 'decouplingMeow.generatorInput.v1';
const DEVICES_STORAGE_KEY = 'decouplingMeow.capacitorDevices.v2';
const CAP_VALUES_STORAGE_KEY = 'decouplingMeow.capacitorValues.v1';
const LEGACY_DEVICE_STORAGE_KEY = 'decouplingMeow.capacitorDevice.v1';
const PREFERENCES_STORAGE_KEY = 'decouplingMeow.preferences.v1';
const IFRAME_ID = 'lceda-decoupling-meow-window';
const DEFAULT_CAP_VALUES = Object.freeze({ bulk: '4.7uF', pin: '100nF' });
const SCHEMATIC_GRID_SIZE = 5;

const POWER_PIN_PATTERNS = [
	/^(?:VDD|VCC|AVDD|DVDD|PVDD|IOVDD|VDDIO|VCORE|VBAT|VREF|VIN|VIOIN|VINPA|VNWA|VOUT|VPP)[\w+-]*$/i,
	/^(?:[ADP]|IO|USB|PLL|RTC)?VDD(?:[ADQ]|IO|CORE|CPU|GPU|MEM)?(?:[_-]?\d+)?$/i,
	/^(?:[ADP]|IO)?VCC(?:A|D|IO)?(?:[_-]?\d+)?$/i,
];

const GROUND_PIN_PATTERNS = [
	/^(?:GND|GROUND|0V)$/i,
	/^(?:[ADP]|CHASSIS|EARTH|SIGNAL)_?GND$/i,
	/^VSS(?:A|D|IO)?\d*$/i,
];

const state = {
	devices: {
		bulk: null,
		pin: null,
	},
	devicePicker: {
		baselineKey: '',
		kind: null,
		token: 0,
	},
	domains: [],
	input: null,
	onlyCandidates: true,
	placementPending: false,
	primitiveIdsSnapshot: new Set(),
	values: { ...DEFAULT_CAP_VALUES },
};

let sequence = 0;

function nextId(prefix) {
	sequence += 1;
	return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function normalizeName(value) {
	return String(value ?? '').trim().replace(/[\s-]+/g, '_');
}

export function isGroundPinName(name) {
	const normalized = normalizeName(name);
	return normalized !== '' && GROUND_PIN_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isPowerCandidate(pin) {
	const name = normalizeName(pin?.name);
	return pin?.noConnected !== true
		&& !isGroundPinName(name)
		&& (pin?.isPowerType === true || POWER_PIN_PATTERNS.some(pattern => pattern.test(name)));
}

export function getPowerDomainSuggestion(pin) {
	const existingNet = String(pin?.net ?? '').trim();
	if (existingNet && !existingNet.startsWith('$')) {
		return {
			groupKey: `net:${existingNet}`,
			label: existingNet,
			source: 'network',
		};
	}
	const pinName = String(pin?.name ?? '').trim() || 'VDD';
	return {
		groupKey: `pin:${pinName}`,
		label: pinName,
		source: 'pin',
	};
}

export function suggestPowerLabel(pin) {
	return getPowerDomainSuggestion(pin).label;
}

function createCap(value, kind, pinNumber = '') {
	return { id: nextId('cap'), kind, pinNumber, value };
}

export function normalizeCapacitanceValue(raw, allowEia = false) {
	const value = String(raw ?? '').trim();
	if (!value)
		return '';
	const compact = value.replaceAll('μ', 'u').replaceAll('µ', 'u').replace(/\s+/g, '');
	const unitMatch = compact.match(/(\d+(?:\.\d+)?)([pnum])f/i);
	if (unitMatch)
		return `${Number(unitMatch[1])}${unitMatch[2].toLowerCase()}F`;
	const embeddedDecimal = compact.match(/^(\d+)([pnum])(\d+)$/i);
	if (embeddedDecimal)
		return `${Number(`${embeddedDecimal[1]}.${embeddedDecimal[3]}`)}${embeddedDecimal[2].toLowerCase()}F`;
	if (allowEia && /^\d{3}$/.test(compact)) {
		const picofarads = Number(compact.slice(0, 2)) * (10 ** Number(compact[2]));
		if (picofarads >= 1_000_000)
			return `${picofarads / 1_000_000}uF`;
		if (picofarads >= 1_000)
			return `${picofarads / 1_000}nF`;
		return `${picofarads}pF`;
	}
	return '';
}

function devicePropertyEntries(device) {
	const sources = [
		device?.property?.otherProperty,
		device?.attributes,
		device?.properties,
	];
	return sources.flatMap(source => source && typeof source === 'object' ? Object.entries(source) : []);
}

export function extractDeviceCapacitance(device) {
	const capacitanceKey = /^(?:value|capacitance|capacity|容量|电容量)$/i;
	for (const [key, value] of devicePropertyEntries(device)) {
		if (!capacitanceKey.test(String(key).trim()))
			continue;
		const normalized = normalizeCapacitanceValue(value, true);
		if (normalized)
			return normalized;
	}
	for (const value of [device?.value, device?.property?.name]) {
		const normalized = normalizeCapacitanceValue(value, false);
		if (normalized)
			return normalized;
	}
	for (const value of [device?.name, device?.description]) {
		const normalized = normalizeCapacitanceValue(value, false);
		if (normalized)
			return normalized;
	}
	return '';
}

function createDomain(label, values = state.values) {
	return {
		bulkCaps: [createCap(values.bulk, 'bulk')],
		bulkEnabled: true,
		id: nextId('domain'),
		label,
		pinCaps: {},
		pinNumbers: [],
	};
}

export function buildInitialDomains(pins, values = DEFAULT_CAP_VALUES) {
	const byGroupKey = new Map();
	for (const pin of pins ?? []) {
		if (!isPowerCandidate(pin))
			continue;
		const suggestion = getPowerDomainSuggestion(pin);
		let domain = byGroupKey.get(suggestion.groupKey);
		if (!domain) {
			domain = createDomain(suggestion.label, values);
			byGroupKey.set(suggestion.groupKey, domain);
		}
		domain.pinNumbers.push(String(pin.number));
		domain.pinCaps[String(pin.number)] = [createCap(values.pin, 'pin', String(pin.number))];
	}
	return [...byGroupKey.values()];
}

function getPin(number) {
	return state.input?.selected?.pins?.find(pin => String(pin.number) === String(number));
}

function getDomainForPin(number) {
	return state.domains.find(domain => domain.pinNumbers.includes(String(number)));
}

function removePinFromDomains(number) {
	const key = String(number);
	for (const domain of state.domains) {
		domain.pinNumbers = domain.pinNumbers.filter(pinNumber => pinNumber !== key);
		delete domain.pinCaps[key];
	}
}

function assignPin(number, domainId, addDefaultCap = true) {
	const key = String(number);
	removePinFromDomains(key);
	const domain = state.domains.find(item => item.id === domainId);
	if (!domain)
		return;
	domain.pinNumbers.push(key);
	domain.pinCaps[key] = addDefaultCap ? [createCap(state.values.pin, 'pin', key)] : [];
}

function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll('\'', '&#039;');
}

function setError(message = '') {
	const banner = document.querySelector('#errorBanner');
	banner.hidden = !message;
	banner.textContent = message;
}

function setSuccess(message = '') {
	const banner = document.querySelector('#successBanner');
	banner.hidden = !message;
	banner.textContent = message;
}

function renderPins() {
	const query = document.querySelector('#pinSearch').value.trim().toLowerCase();
	const pins = (state.input?.selected?.pins ?? []).filter((pin) => {
		const matchesQuery = !query || `${pin.number} ${pin.name} ${pin.type} ${pin.net}`.toLowerCase().includes(query);
		const matchesCandidate = !state.onlyCandidates || isPowerCandidate(pin) || Boolean(getDomainForPin(pin.number));
		return matchesQuery && matchesCandidate;
	});

	const list = document.querySelector('#pinsList');
	list.innerHTML = pins.length > 0
		? pins.map((pin) => {
				const domain = getDomainForPin(pin.number);
				const options = state.domains.map(item => (
					`<option value="${item.id}" ${domain?.id === item.id ? 'selected' : ''}>${escapeHtml(item.label || '未命名电源域')}</option>`
				)).join('');
				return `<div class="pin-row ${domain ? 'assigned' : ''}">
			<label class="pin-checkbox">
				<input type="checkbox" data-pin-toggle="${escapeHtml(pin.number)}" ${domain ? 'checked' : ''} />
				<span class="pin-number">${escapeHtml(pin.number)}</span>
			</label>
			<div class="pin-info">
				<strong>${escapeHtml(pin.name || '未命名引脚')}</strong>
				${pin.net ? `<small>${escapeHtml(pin.net)}</small>` : ''}
			</div>
			<select data-pin-domain="${escapeHtml(pin.number)}" ${domain ? '' : 'disabled'}>
				${options || '<option value="">请先新增电源域</option>'}
			</select>
		</div>`;
			}).join('')
		: '<div class="empty-state">没有符合筛选条件的引脚。</div>';

	list.querySelectorAll('[data-pin-toggle]').forEach((checkbox) => {
		checkbox.addEventListener('change', () => {
			const number = checkbox.dataset.pinToggle;
			if (!checkbox.checked) {
				removePinFromDomains(number);
			}
			else {
				if (state.domains.length === 0)
					state.domains.push(createDomain(suggestPowerLabel(getPin(number))));
				assignPin(number, state.domains[0].id);
			}
			renderAll();
		});
	});

	list.querySelectorAll('[data-pin-domain]').forEach((select) => {
		select.addEventListener('change', () => {
			const number = select.dataset.pinDomain;
			assignPin(number, select.value);
			renderAll();
		});
	});

	const assignedCount = state.domains.reduce((count, domain) => count + domain.pinNumbers.length, 0);
	document.querySelector('#selectedPinCount').textContent = String(assignedCount);
}

function renderCapEditor(cap, domainId, pinNumber = '') {
	return `<div class="cap-editor">
		<input type="text" value="${escapeHtml(cap.value)}" data-cap-value="${cap.id}" aria-label="电容值" />
		<button class="icon-button danger" type="button" data-remove-cap="${cap.id}" data-domain-id="${domainId}" data-pin-number="${escapeHtml(pinNumber)}" title="删除电容">×</button>
	</div>`;
}

function summarizeCaps(caps, emptyLabel = '未设置') {
	if (!caps.length)
		return emptyLabel;
	const values = [...new Set(caps.map(cap => cap.value))];
	if (values.length === 1)
		return caps.length === 1 ? values[0] : `${values[0]} ×${caps.length}`;
	return `${caps.length} 颗自定义`;
}

function renderDomain(domain) {
	const pins = domain.pinNumbers.map(getPin).filter(Boolean);
	const pinCaps = domain.pinNumbers.flatMap(pinNumber => domain.pinCaps[String(pinNumber)] ?? []);
	const bulkSummary = domain.bulkEnabled === false
		? '不放主容'
		: summarizeCaps(domain.bulkCaps, '未设置');
	const pinPreview = pins.map(pin => `Pin ${pin.number}`).join(' / ') || '未分配引脚';
	return `<details class="domain-card" data-domain-id="${domain.id}">
		<summary class="domain-summary">
			<strong class="domain-name" title="网络名称：${escapeHtml(domain.label || '未命名电源域')}">${escapeHtml(domain.label || '未命名电源域')}</strong>
			<span class="domain-pins" title="${escapeHtml(pinPreview)}">${escapeHtml(pinPreview)}</span>
			<label class="summary-bulk-toggle"><input type="checkbox" data-toggle-bulk="${domain.id}" ${domain.bulkEnabled !== false ? 'checked' : ''} /><span>${escapeHtml(bulkSummary)}</span></label>
			<span class="summary-value">${escapeHtml(summarizeCaps(pinCaps))}</span>
			<span class="domain-chevron" aria-hidden="true"></span>
		</summary>
		<div class="domain-editor">
			<div class="domain-editor-heading">
				<label><span>电源标签</span><input list="labelPresets" value="${escapeHtml(domain.label)}" data-domain-label="${domain.id}" /></label>
				<button class="danger-button" type="button" data-delete-domain="${domain.id}">删除此域</button>
			</div>
			<div class="domain-section">
			<div class="domain-section-title">
				<label class="bulk-toggle"><input type="checkbox" data-toggle-bulk="${domain.id}" ${domain.bulkEnabled !== false ? 'checked' : ''} /> 主电容</label>
				<button type="button" data-add-bulk="${domain.id}" ${domain.bulkEnabled === false ? 'disabled' : ''}>增加一颗</button>
			</div>
			<div class="caps-row ${domain.bulkEnabled === false ? 'disabled-caps' : ''}">${domain.bulkCaps.length ? domain.bulkCaps.map(cap => renderCapEditor(cap, domain.id)).join('') : '<span class="empty-inline">未添加主电容</span>'}</div>
		</div>
		<div class="domain-section pin-decoupling-section">
			<div class="domain-section-title"><strong>引脚去耦例外</strong><span>默认每脚 100nF，可单独调整</span></div>
			${pins.length
				? pins.map((pin) => {
						const caps = domain.pinCaps[String(pin.number)] ?? [];
						return `<div class="pin-cap-row">
					<div class="pin-cap-name"><strong>${escapeHtml(pin.name || 'POWER')}</strong><span>Pin ${escapeHtml(pin.number)}</span></div>
					<div class="caps-row">${caps.map(cap => renderCapEditor(cap, domain.id, pin.number)).join('')}<button class="add-cap-button" type="button" data-add-pin-cap="${domain.id}" data-pin-number="${escapeHtml(pin.number)}">增加</button></div>
				</div>`;
					}).join('')
				: '<div class="empty-domain">请从“调整引脚”中分配电源引脚。</div>'}
		</div>
		</div>
	</details>`;
}

function renderDomains() {
	const list = document.querySelector('#domainsList');
	list.innerHTML = state.domains.length > 0
		? state.domains.map(renderDomain).join('')
		: '<div class="empty-state domain-empty">尚无电源域。新增一个电源域，或打开“调整引脚”。</div>';

	list.querySelectorAll('.domain-card').forEach((details) => {
		details.addEventListener('toggle', () => {
			if (!details.open)
				return;
			list.querySelectorAll('.domain-card[open]').forEach((other) => {
				if (other !== details)
					other.open = false;
			});
		});
	});

	list.querySelectorAll('[data-domain-label]').forEach((input) => {
		input.addEventListener('change', () => {
			const domain = state.domains.find(item => item.id === input.dataset.domainLabel);
			if (domain)
				domain.label = input.value.trim();
			renderAll();
		});
	});

	list.querySelectorAll('[data-delete-domain]').forEach((button) => {
		button.addEventListener('click', () => {
			state.domains = state.domains.filter(domain => domain.id !== button.dataset.deleteDomain);
			renderAll();
		});
	});

	list.querySelectorAll('[data-toggle-bulk]').forEach((checkbox) => {
		checkbox.addEventListener('click', event => event.stopPropagation());
		checkbox.addEventListener('change', () => {
			const domain = state.domains.find(item => item.id === checkbox.dataset.toggleBulk);
			if (domain)
				domain.bulkEnabled = checkbox.checked;
			renderAll();
		});
	});

	list.querySelectorAll('[data-add-bulk]').forEach((button) => {
		button.addEventListener('click', () => {
			const domain = state.domains.find(item => item.id === button.dataset.addBulk);
			if (domain)
				domain.bulkCaps.push(createCap(state.values.bulk, 'bulk'));
			renderAll();
		});
	});

	list.querySelectorAll('[data-add-pin-cap]').forEach((button) => {
		button.addEventListener('click', () => {
			const domain = state.domains.find(item => item.id === button.dataset.addPinCap);
			const pinNumber = button.dataset.pinNumber;
			if (domain) {
				domain.pinCaps[pinNumber] ??= [];
				domain.pinCaps[pinNumber].push(createCap(state.values.pin, 'pin', pinNumber));
			}
			renderAll();
		});
	});

	list.querySelectorAll('[data-remove-cap]').forEach((button) => {
		button.addEventListener('click', () => {
			const domain = state.domains.find(item => item.id === button.dataset.domainId);
			if (!domain)
				return;
			const capId = button.dataset.removeCap;
			const pinNumber = button.dataset.pinNumber;
			if (pinNumber)
				domain.pinCaps[pinNumber] = (domain.pinCaps[pinNumber] ?? []).filter(cap => cap.id !== capId);
			else domain.bulkCaps = domain.bulkCaps.filter(cap => cap.id !== capId);
			renderAll();
		});
	});

	list.querySelectorAll('[data-cap-value]').forEach((input) => {
		input.addEventListener('change', () => {
			for (const domain of state.domains) {
				const allCaps = [...domain.bulkCaps, ...Object.values(domain.pinCaps).flat()];
				const cap = allCaps.find(item => item.id === input.dataset.capValue);
				if (cap)
					cap.value = input.value.trim() || '100nF';
			}
			renderPlanSummary();
		});
	});
}

export function validateDomains(domains) {
	const errors = [];
	for (const [index, domain] of (domains ?? []).entries()) {
		if (!String(domain.label ?? '').trim())
			errors.push(`电源域 ${index + 1} 缺少标签。`);
		if (!domain.pinNumbers?.length)
			errors.push(`电源域 ${index + 1} 没有分配引脚。`);
		for (const cap of buildBankPlan(domain)) {
			if (!String(cap.value ?? '').trim())
				errors.push(`电源域 ${index + 1} 存在空电容值。`);
		}
	}
	if (!domains?.length)
		errors.push('至少需要一个电源域。');
	return errors;
}

function countPlan() {
	return state.domains.reduce((summary, domain) => {
		summary.domains += 1;
		summary.labels += domain.pinNumbers.length;
		summary.bulkCaps += domain.bulkEnabled === false ? 0 : domain.bulkCaps.length;
		summary.pinCaps += Object.values(domain.pinCaps).flat().length;
		return summary;
	}, { domains: 0, labels: 0, bulkCaps: 0, pinCaps: 0 });
}

function renderPlanSummary() {
	const summary = countPlan();
	const totalCaps = summary.bulkCaps + summary.pinCaps;
	document.querySelector('#componentBadge').innerHTML = `<strong>${escapeHtml(state.input?.selected?.designator || '芯片')}</strong><span>${summary.domains} 个电源域 · ${summary.labels} 个电源脚</span>`;
	document.querySelector('#placementSummary').textContent = `本次 ${totalCaps} 颗`;
	document.querySelector('#placeAllButton').textContent = summary.domains > 0
		? `整块放置 ${summary.domains} 个电源域`
		: '整块放置';
}

function renderAll() {
	renderPins();
	renderDomains();
	renderPlanSummary();
}

function minimalDevice(item) {
	return {
		description: item.description ?? '',
		footprintName: item.footprint?.name ?? item.footprintName ?? '',
		libraryUuid: item.libraryUuid,
		name: item.name ?? '',
		symbolName: item.symbol?.name ?? item.symbolName ?? '',
		uuid: item.uuid,
	};
}

function normalizeStoredDevice(device) {
	if (!device?.uuid || !device?.libraryUuid)
		return null;
	return minimalDevice(device);
}

export function buildPersistentPreferences(devices, values) {
	return {
		bulk: {
			device: normalizeStoredDevice(devices?.bulk),
			value: normalizeCapacitanceValue(values?.bulk) || DEFAULT_CAP_VALUES.bulk,
		},
		pin: {
			device: normalizeStoredDevice(devices?.pin),
			value: normalizeCapacitanceValue(values?.pin) || DEFAULT_CAP_VALUES.pin,
		},
		schemaVersion: 1,
	};
}

export function restorePersistentPreferences(preferences, storedDevices = {}, storedValues = {}, legacyDevice = null) {
	const bulkPreference = preferences?.schemaVersion === 1 ? preferences.bulk : null;
	const pinPreference = preferences?.schemaVersion === 1 ? preferences.pin : null;
	return {
		devices: {
			bulk: normalizeStoredDevice(bulkPreference?.device ?? storedDevices.bulk ?? legacyDevice),
			pin: normalizeStoredDevice(pinPreference?.device ?? storedDevices.pin ?? legacyDevice),
		},
		values: {
			bulk: normalizeCapacitanceValue(bulkPreference?.value ?? storedValues.bulk) || DEFAULT_CAP_VALUES.bulk,
			pin: normalizeCapacitanceValue(pinPreference?.value ?? storedValues.pin) || DEFAULT_CAP_VALUES.pin,
		},
	};
}

function deviceKindLabel(kind) {
	return kind === 'bulk' ? '主电容' : '引脚去耦电容';
}

function deviceForCap(cap) {
	return state.devices[cap.kind] ?? null;
}

function renderSelectedDevice(kind) {
	const device = state.devices[kind];
	const element = document.querySelector(`[data-selected-device="${kind}"]`);
	const button = document.querySelector(`[data-open-native-device="${kind}"]`);
	if (button) {
		const active = state.devicePicker.kind === kind;
		button.classList.toggle('picker-active', active);
		button.classList.toggle('ready', Boolean(device));
		button.disabled = active;
	}
	if (state.devicePicker.kind === kind) {
		element.textContent = '等待原生库选择…';
		return;
	}
	if (!device) {
		element.textContent = '选择器件';
		return;
	}
	element.textContent = device.footprintName || device.name;
}

function renderSelectedDevices() {
	renderSelectedDevice('bulk');
	renderSelectedDevice('pin');
	for (const [kind, value] of Object.entries(state.values)) {
		const input = document.querySelector(`[data-global-cap-value="${kind}"]`);
		if (input && document.activeElement !== input)
			input.value = value;
	}
}

async function saveDevices() {
	await Promise.all([
		globalThis.eda.sys_Storage.setExtensionUserConfig(DEVICES_STORAGE_KEY, state.devices),
		savePreferences(),
	]);
}

async function saveCapValues() {
	await Promise.all([
		globalThis.eda.sys_Storage.setExtensionUserConfig(CAP_VALUES_STORAGE_KEY, state.values),
		savePreferences(),
	]);
}

async function savePreferences() {
	const saved = await globalThis.eda.sys_Storage.setExtensionUserConfig(
		PREFERENCES_STORAGE_KEY,
		buildPersistentPreferences(state.devices, state.values),
	);
	if (saved === false)
		throw new Error('保存电容器件偏好失败，请检查扩展存储权限。');
}

export async function applyGlobalCapValue(kind, rawValue) {
	if (kind !== 'bulk' && kind !== 'pin')
		throw new Error('未知的电容类型。');
	const value = normalizeCapacitanceValue(rawValue);
	if (!value)
		throw new Error('请输入带单位的容量，例如 4.7uF 或 100nF。');
	state.values[kind] = value;
	for (const domain of state.domains) {
		const caps = kind === 'bulk'
			? domain.bulkCaps
			: Object.values(domain.pinCaps).flat();
		for (const cap of caps)
			cap.value = value;
	}
	await saveCapValues();
	renderAll();
	renderSelectedDevices();
	return value;
}

function librarySelectionKey(selected) {
	return selected?.uuid && selected.libraryUuid
		? `${selected.libraryUuid}:${selected.uuid}`
		: '';
}

async function applyNativeSelectedDevice(kind, selected, restoreWindow = false) {
	if (!selected?.uuid || !selected.libraryUuid)
		throw new Error('请在嘉立创 EDA 原生器件库中点选一个电容器件。');
	const device = await globalThis.eda.lib_Device.get(selected.uuid, selected.libraryUuid);
	if (!device)
		throw new Error('原生库当前选中项不是可用器件，请选择一个两引脚电容器件。');
	state.devices[kind] = minimalDevice({
		...device,
		libraryUuid: selected.libraryUuid,
		uuid: selected.uuid,
	});
	state.devicePicker.kind = null;
	state.devicePicker.token += 1;
	await saveDevices();
	const synchronizedValue = extractDeviceCapacitance(device);
	if (synchronizedValue)
		await applyGlobalCapValue(kind, synchronizedValue);
	renderSelectedDevices();
	if (restoreWindow)
		await restoreGeneratorWindow();
	setSuccess(`已选择${deviceKindLabel(kind)}：${state.devices[kind].name}${synchronizedValue ? `，容量已同步为 ${synchronizedValue}` : ''}`);
}

async function watchNativeDeviceSelection(kind, baselineKey, token) {
	const expiresAt = Date.now() + 120000;
	while (Date.now() < expiresAt && state.devicePicker.token === token) {
		const selected = await globalThis.eda.lib_SelectControl.getSelectedLibraryRowInfo();
		const key = librarySelectionKey(selected);
		if (key && key !== baselineKey) {
			try {
				await applyNativeSelectedDevice(kind, selected, true);
			}
			catch (error) {
				state.devicePicker.kind = null;
				renderSelectedDevices();
				await restoreGeneratorWindow();
				setError(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		await sleep(300);
	}
	if (state.devicePicker.token === token) {
		state.devicePicker.kind = null;
		state.devicePicker.token += 1;
		renderSelectedDevices();
		await restoreGeneratorWindow();
		setError('未检测到新的原生库选择，请重新点击器件按钮后选择。');
	}
}

async function openNativeDevicePicker(kind) {
	setError('');
	try {
		const current = await globalThis.eda.lib_SelectControl.getSelectedLibraryRowInfo();
		state.devicePicker.kind = kind;
		state.devicePicker.baselineKey = librarySelectionKey(current);
		state.devicePicker.token += 1;
		const token = state.devicePicker.token;
		globalThis.eda.sys_PanelControl.openBottomPanel(
			globalThis.ESYS_BottomPanelTab?.LIBRARY ?? 'library',
		);
		renderSelectedDevices();
		setSuccess(`已打开下方原生器件库：请选择${deviceKindLabel(kind)}，选中后自动返回。`);
		await globalThis.eda.sys_Message.showToastMessage(`请在原生器件库中选择${deviceKindLabel(kind)}，去耦喵会自动返回。`);
		await globalThis.eda.sys_IFrame.hideIFrame(IFRAME_ID);
		void watchNativeDeviceSelection(kind, state.devicePicker.baselineKey, token);
	}
	catch (error) {
		state.devicePicker.kind = null;
		renderSelectedDevices();
		await restoreGeneratorWindow();
		setError(error instanceof Error ? error.message : String(error));
	}
}

export function buildBankPlan(domain) {
	const pinCaps = (domain?.pinNumbers ?? []).flatMap((pinNumber) => {
		return domain?.pinCaps?.[String(pinNumber)] ?? [];
	});
	const bulkCaps = domain?.bulkEnabled === false ? [] : (domain?.bulkCaps ?? []);
	return [...bulkCaps, ...pinCaps];
}

export function allocateCapacitorDesignators(existingDesignators, count) {
	const highest = (existingDesignators ?? []).reduce((maximum, designator) => {
		const match = /^C(\d+)$/i.exec(String(designator ?? '').trim());
		return match ? Math.max(maximum, Number(match[1])) : maximum;
	}, 0);
	return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => `C${highest + index + 1}`);
}

async function nextCapacitorDesignators(count) {
	const ids = await globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId();
	const components = ids.length
		? await globalThis.eda.sch_PrimitiveComponent.get(ids)
		: [];
	return allocateCapacitorDesignators(
		components.map(component => component.getState_Designator?.()),
		count,
	);
}

function primitiveIdOf(primitive) {
	const id = primitive?.getState_PrimitiveId?.();
	if (!id)
		throw new Error('创建的图元没有返回有效 ID。');
	return id;
}

async function createPowerFlag(net, x, y) {
	const flag = await globalThis.eda.sch_PrimitiveComponent.createNetFlag('Power', net, x, y);
	if (!flag)
		throw new Error(`创建电源标签 ${net} 失败。`);
	return primitiveIdOf(flag);
}

async function createGroundFlag(x, y, net = 'GND') {
	const flag = await globalThis.eda.sch_PrimitiveComponent.createNetFlag('Ground', net, x, y);
	if (!flag)
		throw new Error('创建 GND 标签失败。');
	return primitiveIdOf(flag);
}

async function setCapacitorValue(component, value) {
	const asyncComponent = component.toAsync();
	asyncComponent.setState_OtherProperty({
		...(component.getState_OtherProperty() ?? {}),
		Value: value,
	});
	return await asyncComponent.done();
}

export function selectCapacitorTextAttributes(attributes, intendedValue) {
	const visible = (attributes ?? []).filter((attribute) => {
		return Number.isFinite(attribute.getState_X?.())
			&& attribute.getState_ValueVisible?.() !== false;
	});
	const designator = visible.find((attribute) => {
		return String(attribute.getState_Key?.() ?? '').trim().toUpperCase() === 'DESIGNATOR';
	});
	const valueCandidates = visible.filter((attribute) => {
		const key = String(attribute.getState_Key?.() ?? '').trim().toUpperCase();
		const value = String(attribute.getState_Value?.() ?? '').trim();
		return key === 'VALUE'
			|| (key === 'NAME' && (value.toUpperCase().includes('{VALUE}') || value === intendedValue));
	});
	const valueAttribute = valueCandidates.find((attribute) => {
		return String(attribute.getState_Value?.() ?? '').toUpperCase().includes('{VALUE}');
	}) ?? valueCandidates.find((attribute) => {
		return String(attribute.getState_Value?.() ?? '').trim() === intendedValue;
	}) ?? valueCandidates[0];
	return [...new Map([designator, valueAttribute]
		.filter(Boolean)
		.map(attribute => [attribute.getState_PrimitiveId(), attribute])).values()];
}

export async function shiftCapacitorTextRight(componentId, intendedValue, gridSize = 10) {
	const attributes = await globalThis.eda.sch_PrimitiveAttribute.getAll(componentId);
	const selected = selectCapacitorTextAttributes(attributes, intendedValue);
	await Promise.all(selected.map(async (attribute) => {
		const x = attribute.getState_X();
		const primitiveId = attribute.getState_PrimitiveId();
		const targetX = x + gridSize;
		const modified = await globalThis.eda.sch_PrimitiveAttribute.modify(primitiveId, { x: targetX });
		if (!modified)
			throw new Error(`移动电容文字 ${attribute.getState_Key()} 失败。`);
		let afterX = modified.getState_X?.();
		if (!Number.isFinite(afterX) || Math.abs(afterX - targetX) > 0.001) {
			const refreshed = await globalThis.eda.sch_PrimitiveAttribute.get(primitiveId);
			afterX = refreshed?.getState_X?.();
		}
		if (!Number.isFinite(afterX) || Math.abs(afterX - targetX) > 0.001)
			throw new Error(`电容文字 ${attribute.getState_Key()} 未移动到目标位置。`);
	}));
	return selected.length;
}

export async function mapConcurrent(items, limit, worker) {
	const values = [...(items ?? [])];
	const results = Array.from({ length: values.length });
	let nextIndex = 0;
	let firstError;
	const runWorker = async () => {
		while (!firstError && nextIndex < values.length) {
			const index = nextIndex;
			nextIndex += 1;
			try {
				results[index] = await worker(values[index], index);
			}
			catch (error) {
				firstError ??= error;
			}
		}
	};
	const workerCount = Math.min(Math.max(1, Number(limit) || 1), values.length);
	await Promise.all(Array.from({ length: workerCount }, runWorker));
	if (firstError)
		throw firstError;
	return results;
}

async function createCapacitorAt(cap, x, y, created, designator) {
	const device = deviceForCap(cap);
	if (!device)
		throw new Error(`${deviceKindLabel(cap.kind)}尚未选择器件。`);
	const component = await globalThis.eda.sch_PrimitiveComponent.create(
		{ libraryUuid: device.libraryUuid, uuid: device.uuid },
		x,
		y,
		'',
		90,
		false,
		true,
		true,
	);
	if (!component)
		throw new Error(`创建 ${cap.value} 电容失败。`);
	const componentId = primitiveIdOf(component);
	created.componentIds.push(componentId);
	return await prepareCapacitor(component, cap, designator);
}

async function prepareCapacitor(component, cap, designator) {
	const componentId = primitiveIdOf(component);
	const x = component.getState_X();
	const y = component.getState_Y();
	const rotated = await globalThis.eda.sch_PrimitiveComponent.modify(componentId, {
		rotation: 90,
		x,
		y,
		...(designator ? { designator } : {}),
	});
	if (!rotated)
		throw new Error(`旋转 ${cap.value} 电容失败。`);
	if (designator && rotated.getState_Designator?.() !== designator)
		throw new Error(`电容位号未能设置为 ${designator}。`);
	await setCapacitorValue(rotated, cap.value);
	await shiftCapacitorTextRight(componentId, cap.value);
	const pins = await globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);
	if (!pins || pins.length !== 2)
		throw new Error('所选电容器件必须恰好具有两个引脚。');
	const { groundPin, powerPin } = orderVerticalPinsByRole(pins);
	if (groundPin.getState_Y() === powerPin.getState_Y())
		throw new Error('电容符号旋转后引脚仍未竖直排列，请更换标准电容器件。');
	return {
		cap,
		componentId,
		groundPin,
		powerPin,
	};
}

export function orderVerticalPinsByRole(pins) {
	const sortedPins = [...pins].sort((a, b) => a.getState_Y() - b.getState_Y());
	return {
		groundPin: sortedPins[0],
		powerPin: sortedPins[1],
	};
}

export function buildSharedBusPlan(points) {
	if (!points?.length)
		throw new Error('母线至少需要一个电容连接点。');
	const longest = [...points].sort((a, b) => {
		return (b.powerY - b.groundY) - (a.powerY - a.groundY);
	})[0];
	const powerX = point => point.powerX ?? point.x;
	const groundX = point => point.groundX ?? point.x;
	const firstPowerX = powerX(points[0]);
	const firstGroundX = groundX(points[0]);
	const rightPowerX = Math.max(...points.map(powerX));
	const rightGroundX = Math.max(...points.map(groundX));
	const powerY = longest.powerY;
	const groundY = longest.groundY;
	return {
		ground: {
			bus: [firstGroundX, groundY, rightGroundX, groundY],
			drops: points
				.filter(point => Math.abs(point.groundY - groundY) > 0.001)
				.map(point => [groundX(point), point.groundY, groundX(point), groundY]),
			flag: { x: firstGroundX, y: groundY },
		},
		power: {
			bus: [firstPowerX, powerY, rightPowerX, powerY],
			drops: points
				.filter(point => Math.abs(point.powerY - powerY) > 0.001)
				.map(point => [powerX(point), point.powerY, powerX(point), powerY]),
			flag: { x: firstPowerX, y: powerY },
		},
	};
}

async function createWire(line, net, created) {
	const wire = await globalThis.eda.sch_PrimitiveWire.create(line, net);
	if (!wire)
		throw new Error(`创建${net ? ` ${net}` : ''}连接导线失败。`);
	const id = primitiveIdOf(wire);
	created.wireIds.push(id);
	return id;
}

export function isDrawableWireLine(line) {
	return Array.isArray(line)
		&& line.length >= 4
		&& (Math.abs(Number(line[0]) - Number(line[2])) > 0.001
			|| Math.abs(Number(line[1]) - Number(line[3])) > 0.001);
}

async function createConnectedBankWires(powerPlan, groundPlan, created) {
	const ids = [];
	const powerBus = powerPlan.bus ?? powerPlan;
	if (isDrawableWireLine(powerBus))
		ids.push(await createWire(powerBus, undefined, created));
	if (isDrawableWireLine(groundPlan.bus))
		ids.push(await createWire(groundPlan.bus, undefined, created));
	for (const drop of powerPlan.drops ?? []) {
		if (isDrawableWireLine(drop))
			ids.push(await createWire(drop, undefined, created));
	}
	for (const drop of groundPlan.drops ?? []) {
		if (isDrawableWireLine(drop))
			ids.push(await createWire(drop, undefined, created));
	}
	return ids;
}

async function rollback(created) {
	const rollbackFailures = [];
	const deleteCurrentWires = async (extraIds = []) => {
		const currentIds = new Set(await globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId());
		const stableNewIds = created.wireBaseline
			? [...currentIds].filter(id => !created.wireBaseline.has(id))
			: [];
		for (const id of [...new Set([...extraIds, ...stableNewIds])].reverse()) {
			if (!currentIds.has(id))
				continue;
			try {
				const deleted = await globalThis.eda.sch_PrimitiveWire.delete([id]);
				if (deleted === false) {
					const stillExists = (await globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId()).includes(id);
					if (stillExists)
						rollbackFailures.push(`导线 ${id}`);
				}
			}
			catch (error) {
				rollbackFailures.push(error instanceof Error ? error.message : String(error));
			}
		}
	};
	if (created.wireBaseline || created.wireIds.length) {
		try {
			await deleteCurrentWires(created.wireIds);
			if (created.wireBaseline)
				await deleteCurrentWires();
		}
		catch (error) {
			rollbackFailures.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const id of [...new Set(created.componentIds)].reverse()) {
		try {
			const deleted = await globalThis.eda.sch_PrimitiveComponent.delete([id]);
			if (deleted === false) {
				const stillExists = (await globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId()).includes(id);
				if (stillExists)
					rollbackFailures.push(`图元 ${id}`);
			}
		}
		catch (error) {
			rollbackFailures.push(error instanceof Error ? error.message : String(error));
		}
	}
	return rollbackFailures;
}

async function refreshPrimitiveIdsSnapshot() {
	state.primitiveIdsSnapshot = new Set(await globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId());
}

async function restoreGeneratorWindow() {
	try {
		await globalThis.eda.sys_IFrame.showIFrame(IFRAME_ID);
	}
	catch {
		// V3.2.149 restores the window but can still throw an internal cmdKey error.
	}
}

async function clearFollowMouseTip() {
	try {
		await globalThis.eda.sys_Message.removeFollowMouseTip();
	}
	catch {
		// Removing an already detached tip can throw the same internal cmdKey error.
	}
}

function domainPlacementErrors(domain) {
	const errors = validateDomains([domain]);
	const caps = buildBankPlan(domain);
	if (!caps.length)
		errors.push('该电源域至少需要一个电容。');
	for (const kind of new Set(caps.map(cap => cap.kind))) {
		if (!state.devices[kind])
			errors.push(`请先从嘉立创原生器件库选择${deviceKindLabel(kind)}器件。`);
	}
	return errors;
}

async function generateDomainBank(domain, preparedAnchor, anchorX, anchorY, created, remainingDesignators = []) {
	const caps = buildBankPlan(domain);
	const remaining = await mapConcurrent(caps.slice(1), 3, (cap, index) => {
		return createCapacitorAt(cap, anchorX + (index + 1) * 40, anchorY, created, remainingDesignators[index]);
	});
	const placedCaps = [preparedAnchor, ...remaining];
	const busPlan = buildSharedBusPlan(placedCaps.map(placed => ({
		groundX: placed.groundPin.getState_X(),
		groundY: placed.groundPin.getState_Y(),
		powerX: placed.powerPin.getState_X(),
		powerY: placed.powerPin.getState_Y(),
	})));
	const powerFlagId = await createPowerFlag(domain.label, busPlan.power.flag.x, busPlan.power.flag.y);
	created.componentIds.push(powerFlagId);
	const groundFlagId = await createGroundFlag(busPlan.ground.flag.x, busPlan.ground.flag.y);
	created.componentIds.push(groundFlagId);
	await createConnectedBankWires(busPlan.power, busPlan.ground, created);
	return {
		capacitorIds: placedCaps.map(placed => placed.componentId),
		groundFlagId,
		powerFlagId,
	};
}

function componentGeometry(component) {
	return {
		x: Number(component.getState_X()),
		y: Number(component.getState_Y()),
	};
}

function lineCoordinates(line) {
	return (Array.isArray(line?.[0]) ? line.flat() : [...(line ?? [])]).map(Number);
}

export function isUniformlyTranslated(before, after, deltaX, deltaY, tolerance = 0.001) {
	if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length)
		return false;
	return before.every((value, index) => {
		const delta = index % 2 === 0 ? deltaX : deltaY;
		return Math.abs((Number(value) + delta) - Number(after[index])) <= tolerance;
	});
}

export function areCoordinatesOnGrid(coordinates, gridSize = SCHEMATIC_GRID_SIZE, tolerance = 0.001) {
	if (!Number.isFinite(gridSize) || gridSize <= 0)
		return false;
	return (coordinates ?? []).every((coordinate) => {
		const value = Number(coordinate);
		return Number.isFinite(value)
			&& Math.abs(value - Math.round(value / gridSize) * gridSize) <= tolerance;
	});
}

async function captureStagedGeometry(componentIds, wireIds) {
	const components = await globalThis.eda.sch_PrimitiveComponent.get(componentIds);
	const wires = wireIds.length
		? await globalThis.eda.sch_PrimitiveWire.get(wireIds)
		: [];
	return {
		components: Object.fromEntries(components.map(component => [
			primitiveIdOf(component),
			componentGeometry(component),
		])),
		wires: Object.fromEntries(wires.map(wire => [
			primitiveIdOf(wire),
			lineCoordinates(wire.getState_Line()),
		])),
	};
}

async function createStagedDomainGroup(domain, x = -20000, y = -20000) {
	const created = {
		componentIds: [],
		wireBaseline: new Set(await globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId()),
		wireIds: [],
	};
	try {
		const caps = buildBankPlan(domain);
		const designators = await nextCapacitorDesignators(caps.length);
		const anchor = await createCapacitorAt(caps[0], x, y, created, designators[0]);
		const flags = await generateDomainBank(domain, anchor, x, y, created, designators.slice(1));
		created.wireIds = (await globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId())
			.filter(id => !created.wireBaseline.has(id));
		const geometry = await captureStagedGeometry(created.componentIds, created.wireIds);
		return {
			capCount: caps.length,
			capacitorIds: flags.capacitorIds,
			created,
			designators,
			flags,
			geometry,
			origin: { x, y },
		};
	}
	catch (error) {
		const rollbackFailures = await rollback(created);
		const suffix = rollbackFailures.length
			? ` 临时组回滚仍有 ${rollbackFailures.length} 项失败。`
			: '';
		throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
	}
}

async function finalizeDomainPlacement(domain, anchorComponent) {
	const created = {
		componentIds: [primitiveIdOf(anchorComponent)],
		wireBaseline: null,
		wireIds: [],
	};

	try {
		created.wireBaseline = new Set(await globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId());
		await clearFollowMouseTip();
		const anchorX = anchorComponent.getState_X();
		const anchorY = anchorComponent.getState_Y();
		const caps = buildBankPlan(domain);
		const preparedAnchor = await prepareCapacitor(anchorComponent, caps[0]);
		await generateDomainBank(domain, preparedAnchor, anchorX, anchorY, created);
		return caps.length;
	}
	catch (error) {
		const rollbackFailures = await rollback(created);
		const rollbackMessage = rollbackFailures.length
			? ` 回滚仍有 ${rollbackFailures.length} 项失败，请检查本次新增图元。`
			: ' 本次新增图元已回滚。';
		throw new Error(`${error instanceof Error ? error.message : String(error)}${rollbackMessage}`);
	}
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function componentPoint(component) {
	return {
		x: Number(component?.getState_X?.()),
		y: Number(component?.getState_Y?.()),
	};
}

export function selectClosestPlacedComponent(components, point) {
	const originX = Number(point?.x);
	const originY = Number(point?.y);
	if (!Number.isFinite(originX) || !Number.isFinite(originY))
		return undefined;
	const sorted = (components ?? [])
		.map(component => ({ component, point: componentPoint(component) }))
		.filter(item => Number.isFinite(item.point.x) && Number.isFinite(item.point.y))
		.sort((left, right) => {
			const leftDistance = ((left.point.x - originX) ** 2) + ((left.point.y - originY) ** 2);
			const rightDistance = ((right.point.x - originX) ** 2) + ((right.point.y - originY) ** 2);
			return leftDistance - rightDistance;
		});
	return sorted[0]?.component;
}

export function matchesLibraryDevice(component, device) {
	const linked = component?.getState_Component?.();
	return Boolean(linked?.uuid && linked?.libraryUuid
		&& linked.uuid === device?.uuid
		&& linked.libraryUuid === device?.libraryUuid);
}

async function waitForPlacedComponent(ignoredIds, device, timeoutMs = 120000) {
	const EDA = globalThis.eda;
	const expiresAt = Date.now() + timeoutMs;
	while (Date.now() < expiresAt) {
		const ids = await EDA.sch_PrimitiveComponent.getAllPrimitiveId();
		const candidateIds = ids.filter(id => !ignoredIds.has(id));
		if (candidateIds.length) {
			const components = await EDA.sch_PrimitiveComponent.get(candidateIds);
			const placed = components.find(component => matchesLibraryDevice(component, device));
			if (placed)
				return placed;
		}
		await sleep(20);
	}
	throw new Error('等待鼠标落位超时，请重新点击放置。');
}

export function getExtraPlacementAnchorIds(components, anchorId) {
	return (components ?? [])
		.map(primitiveIdOf)
		.filter(id => id !== anchorId);
}

async function removeExtraPlacementAnchors(components, anchorId) {
	const extraIds = getExtraPlacementAnchorIds(components, anchorId);
	for (const id of extraIds) {
		const deleted = await globalThis.eda.sch_PrimitiveComponent.delete([id]);
		if (deleted === false) {
			const stillExists = (await globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId()).includes(id);
			if (stillExists)
				throw new Error(`清理重复锚点 ${id} 失败。`);
		}
	}
	return extraIds.length;
}

async function finishMousePlacementTool() {
	const schematicRuntime = globalThis.parent?.SCH ?? globalThis.SCH;
	if (typeof schematicRuntime?.doCommand !== 'function')
		throw new Error('当前客户端没有提供结束鼠标放置工具的命令。');
	await schematicRuntime.doCommand('draw_end');
	await sleep(50);
}

function getSchematicRuntime() {
	const runtime = globalThis.parent?.SCH ?? globalThis.SCH;
	if (typeof runtime?.doCommand !== 'function')
		throw new Error('当前客户端没有提供整组移动命令。');
	return runtime;
}

async function selectStagedDomainGroup(staged) {
	const selectControl = globalThis.eda.sch_SelectControl;
	const cleared = selectControl.clearSelected();
	if (cleared === false)
		throw new Error('清除芯片原有选择失败，已中止整组移动。');
	const lingeringIds = await selectControl.getAllSelectedPrimitives_PrimitiveId();
	if (lingeringIds.length)
		throw new Error(`清除芯片原有选择后仍残留 ${lingeringIds.length} 个图元，已中止整组移动。`);
	const ids = [...new Set([
		...staged.created.componentIds,
		...staged.created.wireIds,
	])];
	const selected = await selectControl.doSelectPrimitives(ids);
	if (!selected)
		throw new Error('选中完整电容组失败。');
	const selectedIds = await selectControl.getAllSelectedPrimitives_PrimitiveId();
	const unexpectedIds = findUnexpectedSelectionIds(selectedIds, ids);
	if (unexpectedIds.length)
		throw new Error(`整组选择意外包含 ${unexpectedIds.length} 个页面既有图元，已中止移动。`);
}

export function findUnexpectedSelectionIds(selectedIds, allowedIds) {
	const allowed = new Set(allowedIds ?? []);
	return (selectedIds ?? []).filter(id => !allowed.has(id));
}

function createCanvasPlacementWaiter(timeoutMs = 120000) {
	const targets = [...new Set([globalThis, globalThis.parent].filter(Boolean))];
	let armed = false;
	let settled = false;
	let timeoutId;
	let resolvePromise;
	let rejectPromise;
	let onMouseUp;
	let onKeyDown;
	const cleanup = () => {
		for (const target of targets) {
			target.removeEventListener('mouseup', onMouseUp, true);
			target.removeEventListener('keydown', onKeyDown, true);
		}
		if (timeoutId)
			clearTimeout(timeoutId);
	};
	const finish = (callback, value) => {
		if (settled)
			return;
		settled = true;
		cleanup();
		callback(value);
	};
	onMouseUp = (event) => {
		if (armed && event.button === 0)
			finish(resolvePromise, { x: event.clientX, y: event.clientY });
	};
	onKeyDown = (event) => {
		if (event.key === 'Escape') {
			const error = new Error('已取消当前整组放置。');
			error.code = 'PLACEMENT_CANCELLED';
			finish(rejectPromise, error);
		}
	};
	const promise = new Promise((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
		for (const target of targets) {
			target.addEventListener('mouseup', onMouseUp, true);
			target.addEventListener('keydown', onKeyDown, true);
		}
		timeoutId = setTimeout(() => {
			finish(reject, new Error('等待整组落位超时。'));
		}, timeoutMs);
	});
	return {
		arm() {
			armed = true;
		},
		cancel() {
			if (settled)
				return;
			settled = true;
			cleanup();
		},
		promise,
	};
}

function isPlacementCancelled(error) {
	return error?.code === 'PLACEMENT_CANCELLED';
}

async function waitForStagedGroupMove(staged, timeoutMs = 5000) {
	const expiresAt = Date.now() + timeoutMs;
	while (Date.now() < expiresAt) {
		const components = await globalThis.eda.sch_PrimitiveComponent.get(staged.created.componentIds);
		const anchor = components[0];
		if (anchor) {
			const movedX = Math.abs(anchor.getState_X() - staged.origin.x) > 0.001;
			const movedY = Math.abs(anchor.getState_Y() - staged.origin.y) > 0.001;
			if (movedX || movedY)
				return;
		}
		await sleep(20);
	}
	throw new Error('整组移动结束后仍停留在临时位置。');
}

async function validateStagedDomainPlacement(staged, domain) {
	const components = await globalThis.eda.sch_PrimitiveComponent.get(staged.created.componentIds);
	const componentMap = new Map(components.map(component => [primitiveIdOf(component), component]));
	const anchorId = staged.capacitorIds[0];
	const anchor = componentMap.get(anchorId);
	const anchorBefore = staged.geometry.components[anchorId];
	if (!anchor || !anchorBefore)
		throw new Error('落位校验未找到锚点电容。');
	const deltaX = anchor.getState_X() - anchorBefore.x;
	const deltaY = anchor.getState_Y() - anchorBefore.y;

	for (const [primitiveId, before] of Object.entries(staged.geometry.components)) {
		const component = componentMap.get(primitiveId);
		if (!component)
			throw new Error(`落位校验缺少图元 ${primitiveId}。`);
		const after = componentGeometry(component);
		if (!isUniformlyTranslated([before.x, before.y], [after.x, after.y], deltaX, deltaY))
			throw new Error(`图元 ${primitiveId} 未随整组同步移动。`);
	}

	for (const [index, primitiveId] of staged.capacitorIds.entries()) {
		const designator = componentMap.get(primitiveId)?.getState_Designator?.();
		if (designator !== staged.designators[index])
			throw new Error(`电容位号校验失败：预期 ${staged.designators[index]}，实际 ${designator || '空'}。`);
	}

	const powerFlag = componentMap.get(staged.flags.powerFlagId);
	const groundFlag = componentMap.get(staged.flags.groundFlagId);
	if (powerFlag?.getState_Net?.() !== domain.label)
		throw new Error(`电源标签校验失败：预期 ${domain.label}。`);
	if (groundFlag?.getState_Net?.() !== 'GND')
		throw new Error('GND 标签校验失败。');
	const flagCoordinates = [
		powerFlag?.getState_X?.(),
		powerFlag?.getState_Y?.(),
		groundFlag?.getState_X?.(),
		groundFlag?.getState_Y?.(),
	];
	if (!areCoordinatesOnGrid(flagCoordinates))
		throw new Error('电源或 GND 标签未对齐原理图网格。');

	const capacitorPins = await Promise.all(staged.capacitorIds.map(async (primitiveId) => {
		return {
			pins: await globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId),
			primitiveId,
		};
	}));
	for (const { pins, primitiveId } of capacitorPins) {
		const coordinates = pins.flatMap(pin => [pin.getState_X(), pin.getState_Y()]);
		if (!areCoordinatesOnGrid(coordinates))
			throw new Error(`电容 ${componentMap.get(primitiveId)?.getState_Designator?.() || primitiveId} 的引脚未对齐原理图网格。`);
	}

	const wires = staged.created.wireIds.length
		? await globalThis.eda.sch_PrimitiveWire.get(staged.created.wireIds)
		: [];
	const wireMap = new Map(wires.map(wire => [primitiveIdOf(wire), wire]));
	for (const [primitiveId, before] of Object.entries(staged.geometry.wires)) {
		const wire = wireMap.get(primitiveId);
		if (!wire)
			throw new Error(`落位校验缺少导线 ${primitiveId}。`);
		if (!isUniformlyTranslated(before, lineCoordinates(wire.getState_Line()), deltaX, deltaY))
			throw new Error(`导线 ${primitiveId} 未随整组同步移动。`);
		if (!areCoordinatesOnGrid(lineCoordinates(wire.getState_Line())))
			throw new Error(`导线 ${primitiveId} 的顶点未对齐原理图网格。`);
	}
	if (wires.length) {
		const nets = new Set(wires.map(wire => wire.getState_Net?.()).filter(Boolean));
		if (!nets.has(domain.label) || !nets.has('GND'))
			throw new Error(`母线网络校验失败：需要同时连接 ${domain.label} 与 GND。`);
	}
}

function exposeLegacyWindowEvent(event) {
	const bindings = [{ target: globalThis, value: event }];
	if (globalThis.parent && globalThis.parent !== globalThis) {
		const frameRect = globalThis.frameElement?.getBoundingClientRect();
		bindings.push({
			target: globalThis.parent,
			value: {
				button: event.button,
				buttons: event.buttons,
				clientX: event.clientX + (frameRect?.x ?? 0),
				clientY: event.clientY + (frameRect?.y ?? 0),
				type: event.type,
			},
		});
	}
	const previous = bindings.map(({ target }) => Object.getOwnPropertyDescriptor(target, 'event'));
	for (const { target, value } of bindings) {
		Object.defineProperty(target, 'event', {
			configurable: true,
			value,
		});
	}
	return () => {
		for (const [index, { target }] of bindings.entries()) {
			if (previous[index])
				Object.defineProperty(target, 'event', previous[index]);
			else
				delete target.event;
		}
	};
}

async function placeDomainsAsMovedGroups(mouseEvent) {
	setError('');
	setSuccess('');
	const domains = state.domains.filter(domain => domain.pinNumbers.length > 0);
	if (!domains.length) {
		setError('请至少选择一个电源网络。');
		return;
	}
	const errors = domains.flatMap((domain) => {
		return domainPlacementErrors(domain).map(message => `${domain.label || '未命名网络'}：${message}`);
	});
	if (errors.length) {
		setError(errors.join(' '));
		return;
	}
	if (state.placementPending) {
		setError('当前正在逐组等待鼠标落位。');
		return;
	}

	let runtime;
	try {
		runtime = getSchematicRuntime();
	}
	catch {
		await placeDomainsSequentiallyWithMouse(mouseEvent);
		return;
	}

	const EDA = globalThis.eda;
	state.placementPending = true;
	let completedDomains = 0;
	let completedCaps = 0;
	let windowHidden = false;

	try {
		for (const [index, domain] of domains.entries()) {
			let staged;
			let placementWaiter;
			try {
				staged = await createStagedDomainGroup(domain);
				await selectStagedDomainGroup(staged);
				placementWaiter = createCanvasPlacementWaiter();
				await runtime.doCommand('MOVE_BY_CENTER_POINT');
				placementWaiter.arm();
				await EDA.sys_Message.showFollowMouseTip(`第 ${index + 1}/${domains.length} 组：点击整块放置 ${domain.label} · Esc 取消`);
				if (!windowHidden) {
					await EDA.sys_IFrame.hideIFrame(IFRAME_ID);
					windowHidden = true;
				}
				await placementWaiter.promise;
				placementWaiter = null;
				await waitForStagedGroupMove(staged);
				await runtime.doCommand('align_grid');
				await validateStagedDomainPlacement(staged, domain);
				completedDomains += 1;
				completedCaps += staged.capCount;
			}
			catch (error) {
				placementWaiter?.cancel();
				if (isPlacementCancelled(error)) {
					await clearFollowMouseTip();
					await EDA.sys_Message.showToastMessage('已取消，正在清理当前未完成的电容组。');
				}
				try {
					await runtime.doCommand('draw_end');
				}
				catch {
					// Continue with cleanup using the transaction baselines.
				}
				let rollbackFailures = [];
				if (staged)
					rollbackFailures = await rollback(staged.created);
				const cleanupMessage = rollbackFailures.length
					? ` 当前组回滚仍有 ${rollbackFailures.length} 项失败。`
					: '';
				const failure = new Error(`${error instanceof Error ? error.message : String(error)}${cleanupMessage}`);
				failure.code = error?.code;
				throw failure;
			}
		}
		setSuccess(`已整块放置并校验 ${completedDomains} 个电源网络、${completedCaps} 个电容。`);
	}
	catch (error) {
		const progress = completedDomains > 0 ? `已完成 ${completedDomains}/${domains.length} 组。` : '';
		const message = `${progress}${error instanceof Error ? error.message : String(error)}`;
		if (isPlacementCancelled(error))
			setSuccess(`${message} 当前未完成的组已清理。`);
		else setError(message);
	}
	finally {
		state.placementPending = false;
		await clearFollowMouseTip();
		if (windowHidden)
			await restoreGeneratorWindow();
		await refreshPrimitiveIdsSnapshot();
	}
}

async function placeDomainsSequentiallyWithMouse(mouseEvent) {
	setError('');
	setSuccess('');
	const domains = state.domains.filter(domain => domain.pinNumbers.length > 0);
	if (!domains.length) {
		setError('请至少选择一个电源网络。');
		return;
	}
	const errors = domains.flatMap((domain) => {
		return domainPlacementErrors(domain).map(message => `${domain.label || '未命名网络'}：${message}`);
	});
	if (errors.length) {
		setError(errors.join(' '));
		return;
	}
	if (state.placementPending) {
		setError('当前正在逐组等待鼠标落位。');
		return;
	}

	const EDA = globalThis.eda;
	state.placementPending = true;
	const restoreWindowEvent = exposeLegacyWindowEvent(mouseEvent);
	let completedDomains = 0;
	let completedCaps = 0;
	let windowHidden = false;

	try {
		for (const [index, domain] of domains.entries()) {
			const beforeIds = new Set(state.primitiveIdsSnapshot);
			const anchorDevice = deviceForCap(buildBankPlan(domain)[0]);
			const cleanupComponentIds = new Set();
			let finalizationStarted = false;
			let placementToolStarted = false;

			try {
				placementToolStarted = true;
				const attachPromise = EDA.sch_PrimitiveComponent.placeComponentWithMouse({
					libraryUuid: anchorDevice.libraryUuid,
					uuid: anchorDevice.uuid,
				});
				const attached = await attachPromise;
				if (!attached)
					throw new Error('电容器件未能绑定到鼠标。');
				const attachedId = attached?.getState_PrimitiveId?.();
				if (attachedId && matchesLibraryDevice(attached, anchorDevice))
					cleanupComponentIds.add(attachedId);
				const attachedIds = await EDA.sch_PrimitiveComponent.getAllPrimitiveId();
				const earlyIds = attachedIds.filter(id => !beforeIds.has(id));
				const earlyComponents = earlyIds.length
					? await EDA.sch_PrimitiveComponent.get(earlyIds)
					: [];
				const earlyMatchingComponents = earlyComponents.filter((component) => {
					return matchesLibraryDevice(component, anchorDevice);
				});
				await EDA.sys_Message.showFollowMouseTip(`第 ${index + 1}/${domains.length} 组：点击放置 ${domain.label}`);
				if (!windowHidden) {
					await EDA.sys_IFrame.hideIFrame(IFRAME_ID);
					windowHidden = true;
				}
				const ignoredIds = new Set([...beforeIds, ...attachedIds]);
				const earlyMousePoint = earlyMatchingComponents.length > 1
					? await EDA.sch_SelectControl.getCurrentMousePosition()
					: undefined;
				const placedComponent = earlyMatchingComponents.length > 1
					? (selectClosestPlacedComponent(earlyMatchingComponents, earlyMousePoint) ?? earlyMatchingComponents[0])
					: await waitForPlacedComponent(ignoredIds, anchorDevice);
				const placedId = primitiveIdOf(placedComponent);
				cleanupComponentIds.add(placedId);
				const placedPoint = componentPoint(placedComponent);
				await finishMousePlacementTool();
				const settledIds = (await EDA.sch_PrimitiveComponent.getAllPrimitiveId()).filter(id => !beforeIds.has(id));
				const settledComponents = settledIds.length
					? await EDA.sch_PrimitiveComponent.get(settledIds)
					: [];
				const matchingSettledComponents = settledComponents.filter((component) => {
					return matchesLibraryDevice(component, anchorDevice);
				});
				for (const component of matchingSettledComponents)
					cleanupComponentIds.add(primitiveIdOf(component));
				const likelyAnchors = matchingSettledComponents.filter((component) => {
					const id = primitiveIdOf(component);
					return id === placedId || !attachedIds.includes(id);
				});
				const settledAnchor = selectClosestPlacedComponent(
					likelyAnchors.length ? likelyAnchors : matchingSettledComponents,
					placedPoint,
				);
				if (!settledAnchor)
					throw new Error('放置工具结束后未找到已落下的锚点电容。');
				const settledAnchorId = primitiveIdOf(settledAnchor);
				await removeExtraPlacementAnchors(matchingSettledComponents, settledAnchorId);
				finalizationStarted = true;
				completedCaps += await finalizeDomainPlacement(domain, settledAnchor);
				completedDomains += 1;
				await refreshPrimitiveIdsSnapshot();
			}
			catch (error) {
				let rollbackFailures = [];
				if (placementToolStarted && !finalizationStarted) {
					try {
						await finishMousePlacementTool();
					}
					catch {
						// Continue with cleanup of any component already committed by the tool.
					}
					try {
						rollbackFailures = await rollback({ componentIds: [...cleanupComponentIds], wireIds: [] });
					}
					catch (cleanupError) {
						rollbackFailures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
					}
				}
				const cleanupMessage = rollbackFailures.length
					? ` 锚点清理仍有 ${rollbackFailures.length} 项失败，请检查画布。`
					: '';
				throw new Error(`${error instanceof Error ? error.message : String(error)}${cleanupMessage}`);
			}
		}
		setSuccess(`已逐组追加 ${completedDomains} 个电源网络、${completedCaps} 个电容。`);
	}
	catch (error) {
		const progress = completedDomains > 0 ? `已完成 ${completedDomains}/${domains.length} 组。` : '';
		setError(`${progress}${error instanceof Error ? error.message : String(error)}`);
	}
	finally {
		state.placementPending = false;
		await clearFollowMouseTip();
		if (windowHidden)
			await restoreGeneratorWindow();
		restoreWindowEvent();
		await refreshPrimitiveIdsSnapshot();
	}
}

async function init() {
	try {
		const EDA = globalThis.eda;
		if (!EDA)
			throw new Error('未检测到嘉立创 EDA 扩展环境。');
		state.input = EDA.sys_Storage.getExtensionUserConfig(INPUT_STORAGE_KEY);
		await EDA.sys_Storage.deleteExtensionUserConfig(INPUT_STORAGE_KEY);
		if (!state.input)
			throw new Error('没有找到生成输入，请关闭窗口后重新运行去耦喵。');

		const preferences = EDA.sys_Storage.getExtensionUserConfig(PREFERENCES_STORAGE_KEY) ?? null;
		const legacyDevice = EDA.sys_Storage.getExtensionUserConfig(LEGACY_DEVICE_STORAGE_KEY) ?? null;
		const storedDevices = EDA.sys_Storage.getExtensionUserConfig(DEVICES_STORAGE_KEY) ?? {};
		const storedValues = EDA.sys_Storage.getExtensionUserConfig(CAP_VALUES_STORAGE_KEY) ?? {};
		const restoredPreferences = restorePersistentPreferences(preferences, storedDevices, storedValues, legacyDevice);
		state.devices = restoredPreferences.devices;
		state.values = restoredPreferences.values;
		if (!preferences)
			await savePreferences();
		state.domains = buildInitialDomains(state.input.selected.pins, state.values);
		await refreshPrimitiveIdsSnapshot();

		document.querySelector('#pinSearch').addEventListener('input', renderPins);
		document.querySelector('#onlyCandidatesButton').addEventListener('click', (event) => {
			state.onlyCandidates = !state.onlyCandidates;
			event.currentTarget.classList.toggle('active', state.onlyCandidates);
			renderPins();
		});
		document.querySelector('#addDomainButton').addEventListener('click', () => {
			state.domains.push(createDomain('VDD'));
			renderAll();
		});
		const pinsDrawer = document.querySelector('#pinsDrawer');
		document.querySelector('#adjustPinsButton').addEventListener('click', () => {
			pinsDrawer.hidden = false;
			document.querySelector('#pinSearch').focus();
		});
		document.querySelector('#closePinsButton').addEventListener('click', () => {
			pinsDrawer.hidden = true;
		});
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape')
				pinsDrawer.hidden = true;
		});
		document.querySelectorAll('[data-open-native-device]').forEach((button) => {
			button.addEventListener('click', () => {
				void openNativeDevicePicker(button.dataset.openNativeDevice);
			});
		});
		document.querySelectorAll('[data-global-cap-value]').forEach((input) => {
			input.addEventListener('change', async () => {
				setError('');
				try {
					const value = await applyGlobalCapValue(input.dataset.globalCapValue, input.value);
					setSuccess(`${deviceKindLabel(input.dataset.globalCapValue)}容量已全局更新为 ${value}`);
				}
				catch (error) {
					input.value = state.values[input.dataset.globalCapValue];
					setError(error instanceof Error ? error.message : String(error));
				}
			});
		});
		document.querySelector('#placeAllButton').addEventListener('click', (event) => {
			void placeDomainsAsMovedGroups(event);
		});
		renderSelectedDevices();
		renderAll();
	}
	catch (error) {
		setError(error instanceof Error ? error.message : String(error));
		document.querySelector('#placeAllButton').disabled = true;
	}
}

if (typeof document !== 'undefined') {
	void init();
}
