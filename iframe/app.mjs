const INPUT_STORAGE_KEY = 'decouplingMeow.generatorInput.v1';
const DEVICE_STORAGE_KEY = 'decouplingMeow.capacitorDevice.v1';
const MANIFESTS_STORAGE_KEY = 'decouplingMeow.manifests.v1';

const POWER_PIN_PATTERNS = [
	/^(?:[ADP]|IO|USB|PLL|RTC)?VDD(?:[ADQ]|IO|CORE|CPU|GPU|MEM)?(?:[_-]?\d+)?$/i,
	/^(?:[ADP]|IO)?VCC(?:A|D|IO)?(?:[_-]?\d+)?$/i,
	/^(?:VBAT|VREF[+-]?|VCORE|AVDD|DVDD|PVDD|IOVDD|VDDIO|VIN|VOUT)$/i,
];

const GROUND_PIN_PATTERNS = [
	/^(?:GND|GROUND|0V)$/i,
	/^(?:[ADP]|CHASSIS|EARTH|SIGNAL)_?GND$/i,
	/^VSS(?:A|D|IO)?\d*$/i,
];

const state = {
	device: null,
	deviceResults: [],
	domains: [],
	input: null,
	manifests: [],
	onlyCandidates: true,
	placementSide: 'auto',
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

function setLoading(loading, title = '去耦喵正在生成…', detail = '请不要关闭窗口。') {
	document.querySelector('#loadingOverlay').hidden = !loading;
	document.querySelector('#loadingTitle').textContent = title;
	document.querySelector('#loadingDetail').textContent = detail;
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
			<button class="domain-delete-button" type="button" data-delete-domain="${domain.id}">删除电源域</button>
		</div>
		<div class="domain-section">
			<div class="domain-section-title"><strong>主电容</strong><button type="button" data-add-bulk="${domain.id}">＋ 添加</button></div>
			<div class="caps-row">${domain.bulkCaps.length ? domain.bulkCaps.map(cap => renderCapEditor(cap, domain.id)).join('') : '<span class="empty-inline">未添加主电容</span>'}</div>
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
		for (const cap of [...(domain.bulkCaps ?? []), ...Object.values(domain.pinCaps ?? {}).flat()]) {
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
		summary.bulkCaps += domain.bulkCaps.length;
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

function renderSelectedDevice() {
	const element = document.querySelector('#selectedDevice');
	if (!state.device) {
		element.textContent = '尚未选择；首次使用请搜索并选择一个两引脚电容器件。';
		element.classList.remove('ready');
		return;
	}
	element.innerHTML = `<strong>${escapeHtml(state.device.name)}</strong><span>${escapeHtml(state.device.symbolName || '电容符号')}${state.device.footprintName ? ` · ${escapeHtml(state.device.footprintName)}` : ''}</span>`;
	element.classList.add('ready');
}

async function searchDevices() {
	setError('');
	const keyword = document.querySelector('#deviceSearchInput').value.trim();
	if (!keyword) {
		setError('请输入电容器件搜索关键字。');
		return;
	}
	setLoading(true, '正在搜索器件库…', keyword);
	try {
		state.deviceResults = await globalThis.eda.lib_Device.search(keyword, undefined, undefined, undefined, 30, 1);
		const select = document.querySelector('#deviceResults');
		select.innerHTML = state.deviceResults.length
			? state.deviceResults.map((item, index) => `<option value="${index}">${escapeHtml(item.name)}${item.symbol?.name ? ` · ${escapeHtml(item.symbol.name)}` : ''}${item.footprint?.name ? ` · ${escapeHtml(item.footprint.name)}` : ''}</option>`).join('')
			: '<option value="">没有搜索结果</option>';
		if (state.deviceResults.length) {
			select.selectedIndex = 0;
			state.device = minimalDevice(state.deviceResults[0]);
			await globalThis.eda.sys_Storage.setExtensionUserConfig(DEVICE_STORAGE_KEY, state.device);
			renderSelectedDevice();
		}
	}
	catch (error) {
		setError(error instanceof Error ? error.message : String(error));
	}
	finally {
		setLoading(false);
	}
}

function boundsOfPins(input) {
	const pins = input?.selected?.pins ?? [];
	const xs = pins.map(pin => Number(pin.x)).filter(Number.isFinite);
	const ys = pins.map(pin => Number(pin.y)).filter(Number.isFinite);
	const centerX = Number(input?.selected?.x ?? 0);
	const centerY = Number(input?.selected?.y ?? 0);
	return {
		centerX,
		centerY,
		maxX: xs.length ? Math.max(...xs) : centerX,
		maxY: ys.length ? Math.max(...ys) : centerY,
		minX: xs.length ? Math.min(...xs) : centerX,
		minY: ys.length ? Math.min(...ys) : centerY,
	};
}

export function buildGenerationPlan(input, domains, placementSide = 'auto') {
	const bounds = boundsOfPins(input);
	const plan = [];
	for (const [domainIndex, domain] of domains.entries()) {
		const domainPlan = {
			caps: [],
			id: domain.id,
			label: domain.label,
			pinLabels: [],
		};

		for (const pinNumber of domain.pinNumbers) {
			const pin = input.selected.pins.find(item => String(item.number) === String(pinNumber));
			if (!pin)
				continue;
			domainPlan.pinLabels.push({ pinNumber: String(pin.number), x: pin.x, y: pin.y });
			const pinSide = placementSide === 'auto'
				? (Number(pin.x) < bounds.centerX ? 'left' : 'right')
				: placementSide;
			const pinCaps = domain.pinCaps[String(pin.number)] ?? [];
			for (const [capIndex, cap] of pinCaps.entries()) {
				const direction = pinSide === 'left' ? -1 : 1;
				domainPlan.caps.push({
					...cap,
					x: Number(pin.x) + direction * (65 + capIndex * 38),
					y: Number(pin.y),
				});
			}
		}

		const bankSide = placementSide === 'left' ? 'left' : 'right';
		const bankX = bankSide === 'left' ? bounds.minX - 90 : bounds.maxX + 90;
		for (const [capIndex, cap] of domain.bulkCaps.entries()) {
			domainPlan.caps.push({
				...cap,
				x: bankX + (bankSide === 'left' ? -1 : 1) * capIndex * 38,
				y: bounds.minY - 55 - domainIndex * 48,
			});
		}
		plan.push(domainPlan);
	}
	return plan;
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

async function createCapacitor(cap, domainLabel, createdIds) {
	const component = await globalThis.eda.sch_PrimitiveComponent.create(
		{ libraryUuid: state.device.libraryUuid, uuid: state.device.uuid },
		cap.x,
		cap.y,
		'',
		90,
		false,
		true,
		true,
	);
	if (!component)
		throw new Error(`创建 ${cap.value} 电容失败。`);
	const componentId = primitiveIdOf(component);
	createdIds.push(componentId);
	await setCapacitorValue(component, cap.value);

	const pins = await globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);
	if (!pins || pins.length < 2)
		throw new Error('所选电容器件不是有效的两引脚器件。');
	const powerPin = pins.find(pin => pin.getState_PinNumber() === '1') ?? pins[0];
	const groundPin = pins.find(pin => pin !== powerPin) ?? pins[1];
	const powerFlagId = await createPowerFlag(domainLabel, powerPin.getState_X(), powerPin.getState_Y());
	createdIds.push(powerFlagId);
	const groundFlagId = await createGroundFlag(groundPin.getState_X(), groundPin.getState_Y());
	createdIds.push(groundFlagId);

	return {
		componentId,
		flagIds: [powerFlagId, groundFlagId],
		id: cap.id,
		kind: cap.kind,
		pinNumber: cap.pinNumber ?? '',
		value: cap.value,
	};
}

async function rollback(ids) {
	if (!ids.length)
		return;
	try {
		await globalThis.eda.sch_PrimitiveComponent.delete([...new Set(ids)]);
	}
	catch {
		// Keep the original generation error; the user can remove leftovers manually.
	}
}

async function saveManifests() {
	await globalThis.eda.sys_Storage.setExtensionUserConfig(MANIFESTS_STORAGE_KEY, state.manifests);
}

async function generate() {
	setError('');
	setSuccess('');
	const errors = validateDomains(state.domains);
	if (errors.length) {
		setError(errors.join(' '));
		return;
	}
	if (!state.device) {
		setError('请先搜索并选择一个两引脚电容器件。');
		return;
	}

	const plan = buildGenerationPlan(state.input, state.domains, state.placementSide);
	const createdIds = [];
	const batch = {
		chipDesignator: state.input.selected.designator,
		chipPrimitiveId: state.input.selected.primitiveId,
		createdAt: new Date().toISOString(),
		documentUuid: state.input.document.uuid,
		domains: [],
		id: nextId('batch'),
	};

	setLoading(true, '去耦喵正在生成…', '创建电源标签和电容器件。');
	try {
		for (const domain of plan) {
			const domainManifest = {
				caps: [],
				id: domain.id,
				label: domain.label,
				powerLabelIds: [],
			};
			for (const pinLabel of domain.pinLabels) {
				const id = await createPowerFlag(domain.label, pinLabel.x, pinLabel.y);
				createdIds.push(id);
				domainManifest.powerLabelIds.push(id);
			}
			for (const cap of domain.caps) {
				domainManifest.caps.push(await createCapacitor(cap, domain.label, createdIds));
			}
			batch.domains.push(domainManifest);
		}

		state.manifests.unshift(batch);
		await saveManifests();
		setSuccess(`已生成 ${plan.length} 个电源域、${createdIds.length} 个图元。可在下方按项删除或撤销整批。`);
		renderHistory();
		await globalThis.eda.dmt_EditorControl.activateDocument(state.input.document.tabId);
		await globalThis.eda.sch_SelectControl.clearSelected();
		await globalThis.eda.sch_SelectControl.doSelectPrimitives(createdIds);
		await globalThis.eda.dmt_EditorControl.zoomToSelectedPrimitives(state.input.document.tabId);
	}
	catch (error) {
		await rollback(createdIds);
		setError(`${error instanceof Error ? error.message : String(error)} 本次已创建内容已尝试回滚。`);
	}
	finally {
		setLoading(false);
	}
}

function allIdsForCap(cap) {
	return [cap.componentId, ...(cap.flagIds ?? [])].filter(Boolean);
}

function allIdsForDomain(domain) {
	return [
		...(domain.powerLabelIds ?? []),
		...(domain.caps ?? []).flatMap(allIdsForCap),
	].filter(Boolean);
}

function allIdsForBatch(batch) {
	return (batch.domains ?? []).flatMap(allIdsForDomain);
}

async function deletePrimitiveIds(ids) {
	if (!ids.length)
		return;
	const deleted = await globalThis.eda.sch_PrimitiveComponent.delete([...new Set(ids)]);
	if (!deleted)
		throw new Error('部分图元可能已被手动删除，批量删除没有完全成功。');
}

async function removeCap(batchId, domainId, capId) {
	const batch = state.manifests.find(item => item.id === batchId);
	const domain = batch?.domains.find(item => item.id === domainId);
	const cap = domain?.caps.find(item => item.id === capId);
	if (!batch || !domain || !cap)
		return;
	await deletePrimitiveIds(allIdsForCap(cap));
	domain.caps = domain.caps.filter(item => item.id !== capId);
	await saveManifests();
	renderHistory();
}

async function removeGeneratedDomain(batchId, domainId) {
	const batch = state.manifests.find(item => item.id === batchId);
	const domain = batch?.domains.find(item => item.id === domainId);
	if (!batch || !domain)
		return;
	await deletePrimitiveIds(allIdsForDomain(domain));
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
	await deletePrimitiveIds(allIdsForBatch(batch));
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

		state.device = EDA.sys_Storage.getExtensionUserConfig(DEVICE_STORAGE_KEY) ?? null;
		state.manifests = EDA.sys_Storage.getExtensionUserConfig(MANIFESTS_STORAGE_KEY) ?? [];
		state.domains = buildInitialDomains(state.input.selected.pins);

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
		document.querySelector('#deviceSearchButton').addEventListener('click', searchDevices);
		document.querySelector('#deviceResults').addEventListener('change', async (event) => {
			const item = state.deviceResults[Number(event.currentTarget.value)];
			if (!item)
				return;
			state.device = minimalDevice(item);
			await EDA.sys_Storage.setExtensionUserConfig(DEVICE_STORAGE_KEY, state.device);
			renderSelectedDevice();
		});
		document.querySelectorAll('[data-side]').forEach((button) => {
			button.addEventListener('click', () => {
				state.placementSide = button.dataset.side;
				document.querySelectorAll('[data-side]').forEach(item => item.classList.toggle('active', item === button));
			});
		});
		document.querySelector('#generateButton').addEventListener('click', generate);

		renderSelectedDevice();
		renderAll();
		renderHistory();
	}
	catch (error) {
		setError(error instanceof Error ? error.message : String(error));
		document.querySelector('#generateButton').disabled = true;
	}
}

if (typeof document !== 'undefined') {
	void init();
}
