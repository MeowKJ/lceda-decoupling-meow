import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import JSZip from 'jszip';

async function main() {
	const root = process.cwd();
	const extensionConfig = JSON.parse(await fs.readFile(path.join(root, 'extension.json'), 'utf8'));
	const archivePath = path.join(root, 'build', 'dist', `${extensionConfig.name}_v${extensionConfig.version}.eext`);
	const archive = await JSZip.loadAsync(await fs.readFile(archivePath));
	const privacyMarkerPattern = /e-?mail|mailing|邮箱|邮件|mailto:|[\w.%+-]+@[\w.-]+\.[A-Z]{2,}/i;
	const textFilePattern = /\.(?:css|html|js|json|md|mjs|svg|txt|xml)$/i;
	const violations = [];

	for (const excludedFile of ['LICENSE', 'NOTICE', 'images/usage-demo.gif']) {
		if (archive.file(excludedFile))
			violations.push(`${excludedFile} must stay outside the extension package`);
	}

	for (const [filename, entry] of Object.entries(archive.files)) {
		if (entry.dir || !textFilePattern.test(filename))
			continue;

		const content = await entry.async('string');
		if (privacyMarkerPattern.test(content))
			violations.push(`${filename} contains a privacy-sensitive contact marker`);
	}

	if (violations.length > 0)
		throw new Error(`Package verification failed:\n- ${violations.join('\n- ')}`);

	console.warn(`Verified ${path.relative(root, archivePath)}: no privacy-sensitive contact markers and no bundled usage GIF.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
