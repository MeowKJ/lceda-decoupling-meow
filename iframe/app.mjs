const INPUT_STORAGE_KEY = 'decouplingMeow.generatorInput.v1';
const DEVICES_STORAGE_KEY = 'decouplingMeow.capacitorDevices.v2';
const LEGACY_DEVICE_STORAGE_KEY = 'decouplingMeow.capacitorDevice.v1';
const MANIFESTS_STORAGE_KEY = 'decouplingMeow.manifests.v1';
const IFRAME_ID = 'lceda-decoupling-meow-window';

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
	manifests: [],
	onlyCandidates: true,
	placementPending: false,
	primitiveIdsSnapshot: new Set(),
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

function explicitVoltageLabel(name) {
	const normalized = normalizeName(name).toUpperCase();
	const match = normalized.match(/(?:VDD|VCC|AVDD|DVDD|IOVDD|VDDIO)[_-]?(\d)V?(\d)$/);
	if (!match)
		return '';
	return `+${match[1]}V${match[2]}`;
}

export function suggestPowerLabel(pin) {
	const existingNet = String(pin?.net ?? '').trim();
	if (existingNet && !existingNet.startsWith('$'))
		return existingNet;
	const voltage = explicitVoltageLabel(pin?.name);
	if (voltage)
		return voltage;
	return normalizeName(pin?.name) || 'VDD';
}

function createCap(value, kind, pinNumber = '') {
	return { id: nextId('cap'), kind, pinNumber, value };
}

function createDomain(label) {
	return {
		bulkCaps: [createCap('4.7uF', 'bulk')],
		bulkEnabled: true,
		id: nextId('domain'),
		label,
		pinCaps: {},
		pinNumbers: [],
	};
}

export function buildInitialDomains(pins) {
	const byLabel = new Map();
	for (const pin of pins ?? []) {
		if (!isPowerCandidate(pin))
			continue;
		const label = suggestPowerLabel(pin);
		let domain = byLabel.get(label);
		if (!domain) {
			domain = createDomain(label);
			byLabel.set(label, domain);
		}
		domain.pinNumbers.push(String(pin.number));
		domain.pinCaps[String(pin.number)] = [createCap('100nF', 'pin', String(pin.number))];
	}
	return [...byLabel.values()];
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
	domain.pinCaps[key] = addDefaultCap ? [createCap('100nF', 'pin', key)] : [];
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

function candidateBadge(pin) {
	if (pin.isPowerType)
		return '<span class="pin-badge power">POWER</span>';
	if (isPowerCandidate(pin))
		return '<span class="pin-badge suggested">名称匹配</span>';
	return '';
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
				<small>${escapeHtml(pin.type)}${pin.net ? ` · ${escapeHtml(pin.net)}` : ''}</small>
			</div>
			${candidateBadge(pin)}
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

function renderDomain(domain, index) {
	const pins = domain.pinNumbers.map(getPin).filter(Boolean);
	return `<article class="domain-card" data-domain-id="${domain.id}">
		<div class="domain-header">
			<div class="domain-index">${index + 1}</div>
			<label class="domain-label-field">
				<span>电源标签</span>
				<input list="labelPresets" value="${escapeHtml(domain.label)}" data-domain-label="${domain.id}" />
			</label>
			<div class="domain-actions">
				<button class="domain-delete-button" type="button" data-delete-domain="${domain.id}">删除电源域</button>
			</div>
		</div>
		<div class="domain-section">
			<div class="domain-section-title">
				<label class="bulk-toggle"><input type="checkbox" data-toggle-bulk="${domain.id}" ${domain.bulkEnabled !== false ? 'checked' : ''} /> 主电容</label>
				<button type="button" data-add-bulk="${domain.id}" ${domain.bulkEnabled === false ? 'disabled' : ''}>＋ 添加</button>
			</div>
			<div class="caps-row ${domain.bulkEnabled === false ? 'disabled-caps' : ''}">${domain.bulkCaps.length ? domain.bulkCaps.map(cap => renderCapEditor(cap, domain.id)).join('') : '<span class="empty-inline">未添加主电容</span>'}</div>
		</div>
		<div class="domain-section pin-decoupling-section">
			<div class="domain-section-title"><strong>引脚去耦</strong><span>${pins.length} 个引脚</span></div>
			${pins.length
				? pins.map((pin) => {
						const caps = domain.pinCaps[String(pin.number)] ?? [];
						return `<div class="pin-cap-row">
					<div class="pin-cap-name"><strong>${escapeHtml(pin.name || 'POWER')}</strong><span>Pin ${escapeHtml(pin.number)}</span></div>
					<div class="caps-row">${caps.map(cap => renderCapEditor(cap, domain.id, pin.number)).join('')}<button class="add-cap-button" type="button" data-add-pin-cap="${domain.id}" data-pin-number="${escapeHtml(pin.number)}">＋</button></div>
				</div>`;
					}).join('')
				: '<div class="empty-domain">从左侧勾选引脚，并分配到此电源域。</div>'}
		</div>
	</article>`;
}

function renderDomains() {
	const list = document.querySelector('#domainsList');
	list.innerHTML = state.domains.length > 0
		? state.domains.map(renderDomain).join('')
		: '<div class="empty-state domain-empty">尚无电源域。点击“新增电源域”，或在左侧勾选一个候选引脚。</div>';

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
				domain.bulkCaps.push(createCap('4.7uF', 'bulk'));
			renderAll();
		});
	});

	list.querySelectorAll('[data-add-pin-cap]').forEach((button) => {
		button.addEventListener('click', () => {
			const domain = state.domains.find(item => item.id === button.dataset.addPinCap);
			const pinNumber = button.dataset.pinNumber;
			if (domain) {
				domain.pinCaps[pinNumber] ??= [];
				domain.pinCaps[pinNumber].push(createCap('100nF', 'pin', pinNumber));
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
	document.querySelector('#planSummary').innerHTML = `
		<div><strong>${summary.domains}</strong><span>电源域</span></div>
		<div><strong>${summary.labels}</strong><span>芯片标签</span></div>
		<div><strong>${summary.bulkCaps}</strong><span>主电容</span></div>
		<div><strong>${summary.pinCaps}</strong><span>引脚电容</span></div>`;
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
		name: item.name,
		symbolName: item.symbol?.name ?? item.symbolName ?? '',
		uuid: item.uuid,
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
		button.textContent = active ? '等待选择…' : '选择器件';
		button.classList.toggle('picker-active', active);
		button.disabled = active;
	}
	if (!device) {
		element.textContent = `尚未选择${deviceKindLabel(kind)}器件。`;
		element.classList.remove('ready');
		return;
	}
	element.innerHTML = `<strong>${escapeHtml(device.name)}</strong><span>${escapeHtml(device.symbolName || '电容符号')}${device.footprintName ? ` · ${escapeHtml(device.footprintName)}` : ''}</span>`;
	element.classList.add('ready');
}

function renderSelectedDevices() {
	renderSelectedDevice('bulk');
	renderSelectedDevice('pin');
}

async function saveDevices() {
	await globalThis.eda.sys_Storage.setExtensionUserConfig(DEVICES_STORAGE_KEY, state.devices);
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
	renderSelectedDevices();
	if (restoreWindow)
		await restoreGeneratorWindow();
	setSuccess(`已选择${deviceKindLabel(kind)}：${state.devices[kind].name}`);
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
		setError('未检测到新的原生库选择。可重新打开器件库，或点击“用当前”采用当前高亮器件。');
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

async function useCurrentNativeDevice(kind) {
	setError('');
	try {
		const current = await globalThis.eda.lib_SelectControl.getSelectedLibraryRowInfo();
		await applyNativeSelectedDevice(kind, current);
	}
	catch (error) {
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

async function createGroundFlag(x, y) {
	const flag = await globalThis.eda.sch_PrimitiveComponent.createNetFlag('Ground', 'GND', x, y);
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

async function createCapacitorAt(cap, x, y, created) {
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
	return await prepareCapacitor(component, cap);
}

async function prepareCapacitor(component, cap) {
	const componentId = primitiveIdOf(component);
	const x = component.getState_X();
	const y = component.getState_Y();
	const rotated = await globalThis.eda.sch_PrimitiveComponent.modify(componentId, { rotation: 90, x, y });
	if (!rotated)
		throw new Error(`旋转 ${cap.value} 电容失败。`);
	await setCapacitorValue(rotated, cap.value);
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

async function alignCapToPowerBus(placed, powerBusY) {
	const deltaY = powerBusY - placed.powerPin.getState_Y();
	if (Math.abs(deltaY) < 0.001)
		return placed;
	const [component] = await globalThis.eda.sch_PrimitiveComponent.get([placed.componentId]);
	if (!component)
		throw new Error(`无法重新读取 ${placed.cap.value} 电容。`);
	const moved = await globalThis.eda.sch_PrimitiveComponent.modify(placed.componentId, {
		x: component.getState_X(),
		y: component.getState_Y() + deltaY,
	});
	if (!moved)
		throw new Error(`无法对齐 ${placed.cap.value} 电容的电源引脚。`);
	const pins = await globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(placed.componentId);
	const { groundPin, powerPin } = orderVerticalPinsByRole(pins);
	return { ...placed, groundPin, powerPin };
}

export function buildGroundBusPlan(points, clearance = 20) {
	if (!points?.length)
		throw new Error('接地母线至少需要一个连接点。');
	const busY = Math.min(...points.map(point => point.y)) - clearance;
	const flagX = Math.min(...points.map(point => point.x)) - clearance;
	const rightX = Math.max(...points.map(point => point.x));
	return {
		bus: [flagX, busY, rightX, busY],
		drops: points.map(point => [point.x, point.y, point.x, busY]),
		flag: { x: flagX, y: busY },
	};
}

export function buildDomainRowOrigins(domains, anchorX, anchorY, rowPitch = 100) {
	return (domains ?? []).map((domain, index) => ({
		domain,
		x: anchorX,
		y: anchorY - index * rowPitch,
	}));
}

async function createWire(line, net, created) {
	const wire = await globalThis.eda.sch_PrimitiveWire.create(line, net);
	if (!wire)
		throw new Error(`创建${net ? ` ${net}` : ''}连接导线失败。`);
	const id = primitiveIdOf(wire);
	created.wireIds.push(id);
	return id;
}

async function createConnectedBankWires(powerBus, groundPlan, created) {
	const beforeIds = new Set(await globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId());
	await createWire(powerBus, undefined, created);
	await createWire(groundPlan.bus, undefined, created);
	for (const drop of groundPlan.drops)
		await createWire(drop, undefined, created);
	const stableIds = (await globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId())
		.filter(id => !beforeIds.has(id));
	created.wireIds.push(...stableIds);
	return stableIds;
}

async function rollback(created) {
	for (const id of [...new Set(created.wireIds)].reverse()) {
		try {
			await globalThis.eda.sch_PrimitiveWire.delete([id]);
		}
		catch {
			// Merged intermediate wire IDs may already be stale.
		}
	}
	for (const id of [...new Set(created.componentIds)].reverse()) {
		try {
			await globalThis.eda.sch_PrimitiveComponent.delete([id]);
		}
		catch {
			// Keep the original placement error.
		}
	}
}

async function saveManifests() {
	await globalThis.eda.sys_Storage.setExtensionUserConfig(MANIFESTS_STORAGE_KEY, state.manifests);
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

async function generateDomainBank(domain, preparedAnchor, anchorX, anchorY, created) {
	const caps = buildBankPlan(domain);
	let placedCaps = [preparedAnchor];
	for (const [index, cap] of caps.slice(1).entries()) {
		placedCaps.push(await createCapacitorAt(cap, anchorX + (index + 1) * 35, anchorY, created));
	}
	const powerBusY = placedCaps[0].powerPin.getState_Y();
	placedCaps = await Promise.all(placedCaps.map(cap => alignCapToPowerBus(cap, powerBusY)));

	const domainManifest = {
		bankPowerLabelId: '',
		caps: [],
		groundFlagPoint: null,
		id: domain.id,
		label: domain.label,
		groundFlagId: '',
		powerFlagPoint: null,
		powerLabelIds: [],
		wireIds: [],
	};
	for (const pinNumber of domain.pinNumbers) {
		const pin = getPin(pinNumber);
		if (!pin)
			continue;
		const labelId = await createPowerFlag(domain.label, pin.x, pin.y);
		created.componentIds.push(labelId);
		domainManifest.powerLabelIds.push(labelId);
	}

	const powerPins = placedCaps.map(item => item.powerPin);
	const leftX = Math.min(...powerPins.map(pin => pin.getState_X())) - 20;
	const rightX = Math.max(...powerPins.map(pin => pin.getState_X()));
	const bankPowerLabelId = await createPowerFlag(domain.label, leftX, powerBusY);
	domainManifest.bankPowerLabelId = bankPowerLabelId;
	domainManifest.powerFlagPoint = { x: leftX, y: powerBusY };
	created.componentIds.push(bankPowerLabelId);
	domainManifest.powerLabelIds.push(bankPowerLabelId);
	const powerBus = [leftX, powerBusY, rightX, powerBusY];

	const groundPoints = placedCaps.map(placed => ({
		x: placed.groundPin.getState_X(),
		y: placed.groundPin.getState_Y(),
	}));
	const groundPlan = buildGroundBusPlan(groundPoints);
	domainManifest.groundFlagId = await createGroundFlag(groundPlan.flag.x, groundPlan.flag.y);
	domainManifest.groundFlagPoint = groundPlan.flag;
	created.componentIds.push(domainManifest.groundFlagId);
	domainManifest.wireIds = await createConnectedBankWires(powerBus, groundPlan, created);

	for (const placed of placedCaps) {
		domainManifest.caps.push({
			componentId: placed.componentId,
			groundPoint: {
				x: placed.groundPin.getState_X(),
				y: placed.groundPin.getState_Y(),
			},
			id: placed.cap.id,
			kind: placed.cap.kind,
			pinNumber: placed.cap.pinNumber ?? '',
			powerPoint: {
				x: placed.powerPin.getState_X(),
				y: placed.powerPin.getState_Y(),
			},
			value: placed.cap.value,
		});
	}
	return domainManifest;
}

async function finalizeAllDomainsPlacement(domains, anchorComponent) {
	const created = { componentIds: [primitiveIdOf(anchorComponent)], wireIds: [] };
	const batch = {
		chipDesignator: state.input.selected.designator,
		chipPrimitiveId: state.input.selected.primitiveId,
		createdAt: new Date().toISOString(),
		documentUuid: state.input.document.uuid,
		domains: [],
		id: nextId('batch'),
	};

	try {
		await clearFollowMouseTip();
		const anchorX = anchorComponent.getState_X();
		const anchorY = anchorComponent.getState_Y();
		let totalCaps = 0;
		const rows = buildDomainRowOrigins(domains, anchorX, anchorY);
		for (const [index, row] of rows.entries()) {
			const { domain } = row;
			const caps = buildBankPlan(domain);
			const preparedAnchor = index === 0
				? await prepareCapacitor(anchorComponent, caps[0])
				: await createCapacitorAt(caps[0], row.x, row.y, created);
			batch.domains.push(await generateDomainBank(domain, preparedAnchor, row.x, row.y, created));
			totalCaps += caps.length;
		}
		state.manifests.unshift(batch);
		await saveManifests();
		setSuccess(`已一次生成 ${domains.length} 个电源网络、${totalCaps} 个电容；每个网络使用独立母线和一个 GND 标志。`);
		renderHistory();
	}
	catch (error) {
		await rollback(created);
		setError(`${error instanceof Error ? error.message : String(error)} 本次放置已尝试回滚。`);
	}
	finally {
		state.placementPending = false;
		await clearFollowMouseTip();
		await restoreGeneratorWindow();
	}
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPlacedComponent(ignoredIds, timeoutMs = 120000) {
	const EDA = globalThis.eda;
	const expiresAt = Date.now() + timeoutMs;
	while (Date.now() < expiresAt) {
		const ids = await EDA.sch_PrimitiveComponent.getAllPrimitiveId();
		const placedId = ids.find(id => !ignoredIds.has(id));
		if (placedId) {
			const components = await EDA.sch_PrimitiveComponent.get([placedId]);
			if (components[0])
				return components[0];
		}
		await sleep(100);
	}
	throw new Error('等待鼠标落位超时，请重新点击放置。');
}

async function finishMousePlacementTool() {
	const schematicRuntime = globalThis.parent?.SCH ?? globalThis.SCH;
	if (typeof schematicRuntime?.doCommand !== 'function')
		throw new Error('当前客户端没有提供结束鼠标放置工具的命令。');
	await schematicRuntime.doCommand('draw_end');
	await sleep(50);
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

async function placeAllDomainsWithMouse(mouseEvent) {
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
		setError('当前整批网络正在等待鼠标落位。');
		return;
	}

	const EDA = globalThis.eda;
	const firstCap = buildBankPlan(domains[0])[0];
	const anchorDevice = deviceForCap(firstCap);
	const beforeIds = new Set(state.primitiveIdsSnapshot);
	state.placementPending = true;
	const restoreWindowEvent = exposeLegacyWindowEvent(mouseEvent);

	try {
		const attachPromise = EDA.sch_PrimitiveComponent.placeComponentWithMouse({
			libraryUuid: anchorDevice.libraryUuid,
			uuid: anchorDevice.uuid,
		});
		await EDA.sys_Message.showFollowMouseTip(`点击画布放置 ${domains.length} 个电源网络的去耦组。`);
		await EDA.sys_IFrame.hideIFrame(IFRAME_ID);
		const attached = await attachPromise;
		if (!attached)
			throw new Error('电容器件未能绑定到鼠标。');
		await sleep(50);
		const attachedIds = await EDA.sch_PrimitiveComponent.getAllPrimitiveId();
		const ignoredIds = new Set([...beforeIds, ...attachedIds]);
		await waitForPlacedComponent(ignoredIds);
		await finishMousePlacementTool();
		const settledIds = (await EDA.sch_PrimitiveComponent.getAllPrimitiveId()).filter(id => !beforeIds.has(id));
		const settledAnchor = settledIds.length
			? (await EDA.sch_PrimitiveComponent.get(settledIds))[0]
			: undefined;
		if (!settledAnchor)
			throw new Error('放置工具结束后未找到已落下的锚点电容。');
		await finalizeAllDomainsPlacement(domains, settledAnchor);
	}
	catch (error) {
		state.placementPending = false;
		await clearFollowMouseTip();
		await restoreGeneratorWindow();
		setError(error instanceof Error ? error.message : String(error));
	}
	finally {
		restoreWindowEvent();
		await refreshPrimitiveIdsSnapshot();
	}
}

function emptyPrimitiveSet() {
	return { componentIds: [], wireIds: [] };
}

function mergePrimitiveSets(...sets) {
	return {
		componentIds: sets.flatMap(set => set.componentIds ?? []).filter(Boolean),
		wireIds: sets.flatMap(set => set.wireIds ?? []).filter(Boolean),
	};
}

function primitivesForCap(cap) {
	return {
		componentIds: [cap.componentId, cap.groundFlagId, ...(cap.flagIds ?? [])].filter(Boolean),
		wireIds: [cap.groundWireId].filter(Boolean),
	};
}

function primitivesForDomain(domain) {
	return mergePrimitiveSets(
		{ componentIds: [...(domain.powerLabelIds ?? []), domain.groundFlagId].filter(Boolean), wireIds: domain.wireIds ?? [] },
		...(domain.caps ?? []).map(primitivesForCap),
	);
}

function primitivesForBatch(batch) {
	return mergePrimitiveSets(...(batch.domains ?? []).map(primitivesForDomain));
}

async function deletePrimitiveSet(set = emptyPrimitiveSet()) {
	try {
		if (set.wireIds.length)
			await globalThis.eda.sch_PrimitiveWire.delete([...new Set(set.wireIds)]);
	}
	catch {
		// Already missing wires should not prevent manifest cleanup.
	}
	try {
		if (set.componentIds.length)
			await globalThis.eda.sch_PrimitiveComponent.delete([...new Set(set.componentIds)]);
	}
	catch {
		// Already missing components should not prevent manifest cleanup.
	}
}

async function removeCap(batchId, domainId, capId) {
	const batch = state.manifests.find(item => item.id === batchId);
	const domain = batch?.domains.find(item => item.id === domainId);
	const cap = domain?.caps.find(item => item.id === capId);
	if (!batch || !domain || !cap)
		return;
	const supportsSharedBusRebuild = cap.powerPoint && cap.groundPoint
		&& domain.powerFlagPoint && domain.groundFlagPoint;
	if (!supportsSharedBusRebuild) {
		await deletePrimitiveSet(primitivesForCap(cap));
		domain.caps = domain.caps.filter(item => item.id !== capId);
		await saveManifests();
		renderHistory();
		return;
	}

	await deletePrimitiveSet({
		componentIds: [cap.componentId],
		wireIds: domain.wireIds ?? [],
	});
	domain.caps = domain.caps.filter(item => item.id !== capId);
	if (!domain.caps.length) {
		await deletePrimitiveSet(primitivesForDomain(domain));
		batch.domains = batch.domains.filter(item => item.id !== domainId);
		if (!batch.domains.length)
			state.manifests = state.manifests.filter(item => item.id !== batchId);
		await saveManifests();
		renderHistory();
		return;
	}

	const created = { componentIds: [], wireIds: [] };
	const rightPowerX = Math.max(...domain.caps.map(item => item.powerPoint.x));
	const rightGroundX = Math.max(...domain.caps.map(item => item.groundPoint.x));
	const powerBus = [
		domain.powerFlagPoint.x,
		domain.powerFlagPoint.y,
		rightPowerX,
		domain.powerFlagPoint.y,
	];
	const groundBus = [
		domain.groundFlagPoint.x,
		domain.groundFlagPoint.y,
		rightGroundX,
		domain.groundFlagPoint.y,
	];
	const groundDrops = domain.caps.map(item => [
		item.groundPoint.x,
		item.groundPoint.y,
		item.groundPoint.x,
		domain.groundFlagPoint.y,
	]);
	domain.wireIds = await createConnectedBankWires(powerBus, {
		bus: groundBus,
		drops: groundDrops,
	}, created);
	await saveManifests();
	renderHistory();
}

async function removeGeneratedDomain(batchId, domainId) {
	const batch = state.manifests.find(item => item.id === batchId);
	const domain = batch?.domains.find(item => item.id === domainId);
	if (!batch || !domain)
		return;
	await deletePrimitiveSet(primitivesForDomain(domain));
	batch.domains = batch.domains.filter(item => item.id !== domainId);
	if (!batch.domains.length)
		state.manifests = state.manifests.filter(item => item.id !== batchId);
	await saveManifests();
	renderHistory();
}

async function removeBatch(batchId) {
	const batch = state.manifests.find(item => item.id === batchId);
	if (!batch)
		return;
	await deletePrimitiveSet(primitivesForBatch(batch));
	state.manifests = state.manifests.filter(item => item.id !== batchId);
	await saveManifests();
	renderHistory();
}

function renderHistoryCap(batch, domain, cap) {
	const kind = cap.kind === 'bulk' ? '主电容' : `Pin ${escapeHtml(cap.pinNumber)} 去耦`;
	return `<div class="history-cap"><span>${kind}</span><strong>${escapeHtml(cap.value)}</strong><button type="button" data-history-cap="${cap.id}" data-batch-id="${batch.id}" data-domain-id="${domain.id}">删除</button></div>`;
}

function confirmAction(message) {
	return new Promise((resolve) => {
		globalThis.eda.sys_Dialog.showConfirmationMessage(
			message,
			'去耦喵',
			'确认删除',
			'取消',
			resolve,
		);
	});
}

function renderHistory() {
	const relevant = state.manifests.filter(batch => (
		batch.documentUuid === state.input?.document?.uuid
		&& batch.chipPrimitiveId === state.input?.selected?.primitiveId
	));
	const panel = document.querySelector('#historyPanel');
	panel.hidden = relevant.length === 0;
	const list = document.querySelector('#historyList');
	list.innerHTML = relevant.map(batch => `<article class="history-batch">
		<div class="history-batch-header"><div><strong>${new Date(batch.createdAt).toLocaleString()}</strong><span>${escapeHtml(batch.chipDesignator)}</span></div><button type="button" class="danger-button" data-remove-batch="${batch.id}">撤销整批</button></div>
		${batch.domains.map(domain => `<div class="history-domain">
			<div class="history-domain-header"><strong>${escapeHtml(domain.label)}</strong><button type="button" data-remove-generated-domain="${domain.id}" data-batch-id="${batch.id}">删除此域</button></div>
			<div class="history-caps">${domain.caps.map(cap => renderHistoryCap(batch, domain, cap)).join('') || '<span class="empty-inline">仅保留电源标签</span>'}</div>
		</div>`).join('')}
	</article>`).join('');

	list.querySelectorAll('[data-history-cap]').forEach((button) => {
		button.addEventListener('click', async () => {
			if (!await confirmAction('删除这个已生成电容及其电源/GND标签？'))
				return;
			try {
				await removeCap(button.dataset.batchId, button.dataset.domainId, button.dataset.historyCap);
			}
			catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			}
		});
	});
	list.querySelectorAll('[data-remove-generated-domain]').forEach((button) => {
		button.addEventListener('click', async () => {
			if (!await confirmAction('删除这个电源域由去耦喵创建的全部内容？'))
				return;
			try {
				await removeGeneratedDomain(button.dataset.batchId, button.dataset.removeGeneratedDomain);
			}
			catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			}
		});
	});
	list.querySelectorAll('[data-remove-batch]').forEach((button) => {
		button.addEventListener('click', async () => {
			if (!await confirmAction('撤销本次生成的全部标签和电容？'))
				return;
			try {
				await removeBatch(button.dataset.removeBatch);
			}
			catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			}
		});
	});
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

		const legacyDevice = EDA.sys_Storage.getExtensionUserConfig(LEGACY_DEVICE_STORAGE_KEY) ?? null;
		const storedDevices = EDA.sys_Storage.getExtensionUserConfig(DEVICES_STORAGE_KEY) ?? {};
		state.devices = {
			bulk: storedDevices.bulk ?? legacyDevice,
			pin: storedDevices.pin ?? legacyDevice,
		};
		state.manifests = EDA.sys_Storage.getExtensionUserConfig(MANIFESTS_STORAGE_KEY) ?? [];
		state.domains = buildInitialDomains(state.input.selected.pins);
		await refreshPrimitiveIdsSnapshot();

		document.querySelector('#componentBadge').textContent = `${state.input.selected.designator} · ${state.input.selected.pins.length} Pins`;
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
		document.querySelectorAll('[data-open-native-device]').forEach((button) => {
			button.addEventListener('click', () => {
				void openNativeDevicePicker(button.dataset.openNativeDevice);
			});
		});
		document.querySelectorAll('[data-use-current-device]').forEach((button) => {
			button.addEventListener('click', () => {
				void useCurrentNativeDevice(button.dataset.useCurrentDevice);
			});
		});
		document.querySelector('#placeAllButton').addEventListener('click', (event) => {
			void placeAllDomainsWithMouse(event);
		});
		renderSelectedDevices();
		renderAll();
		renderHistory();
	}
	catch (error) {
		setError(error instanceof Error ? error.message : String(error));
		document.querySelector('#placeAllButton').disabled = true;
	}
}

if (typeof document !== 'undefined') {
	void init();
}
