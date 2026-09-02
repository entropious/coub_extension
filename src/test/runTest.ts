import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
	try {
		// VS Code's integrated terminal sets this, which makes the spawned VS Code
		// start as a plain Node process and reject the GUI flags the runner passes.
		delete process.env.ELECTRON_RUN_AS_NODE;

		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');

		// Download VS Code, unzip it and run the integration test
		await runTests({ 
			extensionDevelopmentPath, 
			extensionTestsPath,
			vscodeExecutablePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
		});
	} catch (err) {
		console.error('Failed to run tests');
		process.exit(1);
	}
}

main();
