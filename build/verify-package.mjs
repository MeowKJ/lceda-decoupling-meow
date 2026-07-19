import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import JSZip from 'jszip';

async function main() {
	const root = process.cwd();
	const extensionConfig = JSON.parse(await fs.readFile(path.join(root, 'extension.json'), 'utf8'));
	const archivePath = path.join(root, 'build', 'dist', `${extensionConfig.name}_v${extensionConfig.version}.eext`);
	const archiveBytes = await fs.readFile(archivePath);
	const archive = await JSZip.loadAsync(archiveBytes);
	const privacyMarkerPattern = /e-?mail|mailing|邮箱|邮件|mailto:|[\w.%+-]+@[\w.-]+\.[A-Z]{2,}/i;
	const textFilePattern = /\.(?:css|html|js|json|md|mjs|svg|txt|xml)$/i;
	const violations = [];

	for (const excludedFile of ['LICENSE', 'NOTICE']) {
		if (archive.file(excludedFile))
			violations.push(`${excludedFile} must stay outside the extension package`);
	}
	for (const requiredMedia of ['images/ui-overview.png', 'images/ui-domain-detail.png', 'images/usage-demo.gif']) {
		if (!archive.file(requiredMedia))
			violations.push(`${requiredMedia} is required for extension review`);
	}

	const demoEntry = archive.file('images/usage-demo.gif');
	if (demoEntry) {
		const demoBytes = await demoEntry.async('uint8array');
		const signature = new TextDecoder().decode(demoBytes.slice(0, 6));
		const width = demoBytes[6] | (demoBytes[7] << 8);
		const height = demoBytes[8] | (demoBytes[9] << 8);
		if (!signature.startsWith('GIF8'))
			violations.push('images/usage-demo.gif is not a valid GIF image');
		if (width < 600 || height < 280)
			violations.push('images/usage-demo.gif is below the 600 x 280 clarity floor');
		if (demoBytes.byteLength > 3_200_000)
			violations.push('images/usage-demo.gif exceeds the 3.2 MB review-media budget');
	}
	if (archiveBytes.byteLength > 5 * 1024 * 1024)
		violations.push('extension package exceeds the 5 MB upload budget');

	for (const [filename, entry] of Object.entries(archive.files)) {
		if (entry.dir || !textFilePattern.test(filename))
			continue;

		const content = await entry.async('string');
		if (privacyMarkerPattern.test(content))
			violations.push(`${filename} contains a privacy-sensitive contact marker`);
	}

	if (violations.length > 0)
		throw new Error(`Package verification failed:\n- ${violations.join('\n- ')}`);

	console.warn(`Verified ${path.relative(root, archivePath)}: review media is bundled, privacy markers are absent, and size budgets pass.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
