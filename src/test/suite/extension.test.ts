import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('alexey.coub-panel'));
	});

	test('Should activate extension', async () => {
		const extension = vscode.extensions.getExtension('alexey.coub-panel');
		await extension?.activate();
		assert.strictEqual(extension?.isActive, true);
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('coub-panel.next'));
		assert.ok(commands.includes('coub-panel.refresh'));
	});
});
