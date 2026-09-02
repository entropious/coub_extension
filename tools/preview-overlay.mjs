// Renders the webview markup from src/extension.ts at several panel widths and
// screenshots each one, so the overlay layout can be checked without VS Code.
//
//   node tools/preview-overlay.mjs [width ...]
//
// Screenshots land in .preview/ (gitignored).

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const widths = process.argv.slice(2).map(Number).filter(Boolean);
const sizes = widths.length > 0 ? widths : [900, 780, 620, 500, 400];

const source = readFileSync('src/extension.ts', 'utf8');
const start = source.indexOf('<!DOCTYPE html>');
const end = source.lastIndexOf('</html>') + '</html>'.length;
if (start < 0 || end < start) {
    throw new Error('Could not find the webview markup in src/extension.ts');
}

// The player itself needs a host: stub the VS Code bridge, keep the overlays
// visible, and stand in for the video with a flat backdrop.
const harness = `
<script>window.acquireVsCodeApi = () => ({ postMessage() {} });</script>
<style>
  #loading-screen, #unmute-overlay { display: none !important; }
  #top-overlay, #bottom-overlay { opacity: 1 !important; }
  .player-wrapper { background: #1b2a3a; }
</style>
`;

const outDir = resolve('.preview');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const page = resolve(outDir, 'overlay.html');
writeFileSync(page, source.slice(start, end).replace('</head>', harness + '</head>'));

// Chrome refuses to make its window narrower than 500px, so each width is
// rendered inside an iframe of exactly that width instead.
for (const width of sizes) {
    const shot = resolve(outDir, `overlay-${width}.png`);
    const frame = resolve(outDir, `frame-${width}.html`);
    writeFileSync(frame, `<body style="margin:0;background:#333">
        <iframe src="overlay.html" style="width:${width}px;height:220px;border:0;display:block"></iframe>
    </body>`);

    execFileSync(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--screenshot=${shot}`,
        `--window-size=${Math.max(width, 520)},220`,
        `file://${frame}`
    ], { stdio: 'ignore' });
    console.log(`${width}px -> ${shot}`);
}
