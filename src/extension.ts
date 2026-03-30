import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


export function activate(context: vscode.ExtensionContext) {
    const provider = new CoubViewProvider(context.extensionUri, context);

    context.subscriptions.push(provider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CoubViewProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('coub-panel.next', () => {
            provider.nextCoub();
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('coub-panel.previous', () => {
            provider.previousCoub();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('coub-panel.refresh', () => {
            provider.refreshFeed();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('coub-panel.toggle-play', () => {
            provider.togglePlay();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('coub-panel.toggle-gemini-sync', () => {
            provider.toggleGeminiSync();
        })
    );
}

class CoubViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'coub-panel.view';
    private _view?: vscode.WebviewView;
    private _coubQueue: any[] = [];
    private _history: any[] = [];
    private _historyIndex: number = -1;
    private _currentCategory: string = 'hot';
    private _page: number = 1;
    public followGeminiEnabled: boolean = true;
    private _geminiWatcher?: fs.FSWatcher;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this.followGeminiEnabled = this._context.globalState.get<boolean>('followGemini', true);
        if (this.followGeminiEnabled) {
            this.startGeminiWatcher();
        }
    }

    public dispose() {
        this.stopGeminiWatcher();
    }

    public startGeminiWatcher() {
        if (this._geminiWatcher) {
            return;
        }

        const geminiDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
        if (!fs.existsSync(geminiDir)) {
            return;
        }

        try {
            this._geminiWatcher = fs.watch(geminiDir, { persistent: false }, (_eventType, filename) => {
                if (filename && filename.endsWith('.pb')) {
                    this.play();
                }
            });
        } catch (err) {
            console.error('Failed to attach Gemini watcher:', err);
        }
    }

    public stopGeminiWatcher() {
        if (this._geminiWatcher) {
            this._geminiWatcher.close();
            this._geminiWatcher = undefined;
        }
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        // Set initial visibility
        vscode.commands.executeCommand('setContext', 'coub-panel.isVisible', webviewView.visible);

        webviewView.onDidChangeVisibility(() => {
            vscode.commands.executeCommand('setContext', 'coub-panel.isVisible', webviewView.visible);
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'webviewReady':
                    webviewView.webview.postMessage({ 
                        type: 'setFollowGemini', 
                        value: this.followGeminiEnabled
                    });
                    await this.nextCoub();
                    break;
                case 'requestNext':
                    await this.nextCoub();
                    break;
                case 'requestPrevious':
                    await this.previousCoub();
                    break;
                case 'toggleFollowGemini':
                    this.setGeminiSync(data.value);
                    break;
                case 'setCategory':
                    this._currentCategory = data.value;
                    this._coubQueue = [];
                    this._history = [];
                    this._historyIndex = -1;
                    this._page = 1;
                    await this.nextCoub();
                    break;
                case 'openExternal':
                    vscode.env.openExternal(vscode.Uri.parse(data.value));
                    break;
            }
        });
    }

    public async nextCoub() {
        // If we are in history, go forward
        if (this._historyIndex < this._history.length - 1) {
            this._historyIndex++;
            this._showCoub(this._history[this._historyIndex]);
            return;
        }

        // Fetch more if queue empty
        if (this._coubQueue.length === 0) {
            await this._fetchCoubs();
        }

        const coub = this._coubQueue.shift();
        if (coub) {
            this._history.push(coub);
            this._historyIndex++;
            this._showCoub(coub);
        }
    }

    public async previousCoub() {
        if (this._historyIndex > 0) {
            this._historyIndex--;
            this._showCoub(this._history[this._historyIndex]);
        }
    }

    private _showCoub(coub: any) {
        if (coub && this._view) {
            this._view.webview.postMessage({
                type: 'loadCoub',
                value: coub
            });
        }
    }

    public play() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'play' });
        }
    }

    public pause() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'pause' });
        }
    }

    public togglePlay() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'toggle' });
        }
    }

    public toggleGeminiSync() {
        this.setGeminiSync(!this.followGeminiEnabled);
    }

    private setGeminiSync(value: boolean) {
        this.followGeminiEnabled = value;
        this._context.globalState.update('followGemini', this.followGeminiEnabled);
        
        if (this.followGeminiEnabled) {
            this.startGeminiWatcher();
        } else {
            this.stopGeminiWatcher();
        }

        if (this._view) {
            this._view.webview.postMessage({ 
                type: 'setFollowGemini', 
                value: this.followGeminiEnabled 
            });
        }
    }

    public refreshFeed() {
        this._coubQueue = [];
        this._page = 1;
        this.nextCoub();
    }

    private async _fetchCoubs() {
        try {
            const endpoint = this._getEndpoint();
            const response = await fetch(`${endpoint}?page=${this._page}&per_page=10`);
            const data: any = await response.json();
            
            if (data && data.coubs) {
                this._coubQueue.push(...data.coubs);
                this._page++;
            }
        } catch (error) {
            console.error('Failed to fetch coubs', error);
            vscode.window.showErrorMessage('Error fetching Coubs from API');
        }
    }

    private _getEndpoint() {
        switch (this._currentCategory) {
            case 'rising': return 'https://coub.com/api/v2/timeline/subscriptions/rising';
            case 'fresh': return 'https://coub.com/api/v2/timeline/explore/fresh';
            case 'random': return 'https://coub.com/api/v2/timeline/explore/random';
            default: return 'https://coub.com/api/v2/timeline/explore/hot';
        }
    }

    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --glass-bg: rgba(30, 30, 30, 0.6);
            --accent-color: #ff3333;
            --text-color: #ffffff;
        }

        body {
            margin: 0;
            padding: 0;
            background: #000;
            color: var(--text-color);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            min-height: 0;
        }

        .container {
            position: relative;
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
        }

        .player-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #000;
            position: relative;
            min-height: 0;
        }

        #coub-video {
            max-width: 100%;
            max-height: 100%;
            width: auto;
            height: auto;
            display: block;
            object-fit: contain;
        }

        #unmute-overlay {
            position: absolute;
            inset: 0;
            background: rgba(0,0,0,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 150;
            cursor: pointer;
            backdrop-filter: blur(2px);
        }

        #unmute-overlay.hidden {
            display: none;
        }

        .overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            padding: 10px;
            background: linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, transparent 100%);
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 100;
            transition: opacity 0.3s;
        }

        .bottom-overlay {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 15px;
            background: linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%);
            z-index: 100;
            transition: opacity 0.3s;
        }

        .controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        button {
            background: var(--glass-bg);
            border: 1px solid rgba(255,255,255,0.1);
            color: white;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            backdrop-filter: blur(10px);
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition: background 0.2s;
        }

        button:hover {
            background: rgba(255,255,255,0.1);
        }

        button.primary {
            background: var(--accent-color);
            border: none;
        }

        select {
            background: var(--glass-bg);
            color: white;
            border: 1px solid rgba(255,255,255,0.1);
            padding: 5px;
            border-radius: 4px;
            font-size: 12px;
            backdrop-filter: blur(10px);
        }

        .title {
            font-size: 14px;
            font-weight: bold;
            text-shadow: 0 1px 2px rgba(0,0,0,0.8);
            margin-bottom: 4px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .metadata {
            font-size: 11px;
            opacity: 0.8;
        }

        .auto-play-container {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
        }

        /* Glassmorphism Slider Toggle */
        .switch {
            position: relative;
            display: inline-block;
            width: 34px;
            height: 20px;
        }

        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--glass-bg);
            transition: .4s;
            border-radius: 20px;
            border: 1px solid rgba(255,255,255,0.1);
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 2px;
            bottom: 2px;
            background-color: white;
            transition: .4s;
            border-radius: 50%;
        }

        input:checked + .slider {
            background-color: var(--accent-color);
        }

        input:checked + .slider:before {
            transform: translateX(14px);
        }

        #loading-screen {
            position: absolute;
            inset: 0;
            background: #000;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 200;
        }

        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid rgba(255,255,255,0.1);
            border-top-color: var(--accent-color);
            border-radius: 50%;
            animation: spin 1s infinite linear;
            margin-bottom: 20px;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .hidden {
            opacity: 0;
            pointer-events: none;
        }
    </style>
</head>
<body>
    <div id="loading-screen">
        <div class="spinner"></div>
        <div style="font-size:13px; opacity:0.6;">Fetching coubs...</div>
    </div>

    <div class="container" id="main-container">
        <div class="overlay" id="top-overlay">
            <div class="controls">
                <select id="category-select">
                    <option value="hot" selected>Hot</option>
                    <option value="random">Random</option>
                    <option value="rising">Rising</option>
                    <option value="fresh">Fresh</option>
                </select>
                <div class="auto-play-container">
                    <span title="Sync with Gemini (Antigravity)">Gemini Sync</span>
                    <label class="switch">
                        <input type="checkbox" id="gemini-toggle" checked>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
            <div class="controls">
                <div class="auto-play-container">
                    <span>Auto-Play</span>
                    <label class="switch">
                        <input type="checkbox" id="auto-play-toggle" checked>
                        <span class="slider"></span>
                    </label>
                </div>
                <button id="previous-btn">Previous</button>
                <button id="next-btn" class="primary">Next</button>
            </div>
        </div>

        <div class="player-wrapper">
            <video id="coub-video" playsinline crossorigin="anonymous"></video>
            <audio id="coub-audio" crossorigin="anonymous"></audio>
            <div id="unmute-overlay">
                <div style="background:var(--accent-color); padding:10px 20px; border-radius:30px; font-weight:bold; box-shadow:0 10px 20px rgba(0,0,0,0.5)">
                    Click to Unmute & Start
                </div>
            </div>
        </div>

        <div class="bottom-overlay" id="bottom-overlay">
            <div id="coub-title" class="title">Loading...</div>
            <div class="controls" style="justify-content: space-between; margin-top: 8px;">
                <div class="metadata" id="coub-meta">By Unknown</div>
                <button id="browser-btn">🌐 View</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const video = document.getElementById('coub-video');
        const audio = document.getElementById('coub-audio');
        const unmuteOverlay = document.getElementById('unmute-overlay');
        const nextBtn = document.getElementById('next-btn');
        const categorySelect = document.getElementById('category-select');
        const autoPlayToggle = document.getElementById('auto-play-toggle');
        const geminiToggle = document.getElementById('gemini-toggle');
        const loadingScreen = document.getElementById('loading-screen');
        const coubTitle = document.getElementById('coub-title');
        const coubMeta = document.getElementById('coub-meta');
        const browserBtn = document.getElementById('browser-btn');
        const topOverlay = document.getElementById('top-overlay');
        const bottomOverlay = document.getElementById('bottom-overlay');

        let currentCoub = null;
        let isMuted = true;
        let syncInterval = null;

        vscode.postMessage({ type: 'webviewReady' });

        const previousBtn = document.getElementById('previous-btn');
        previousBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'requestPrevious' });
        });

        nextBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'requestNext' });
        });

        unmuteOverlay.addEventListener('click', () => {
            isMuted = false;
            unmuteOverlay.classList.add('hidden');
            audio.muted = false;
            video.muted = true;
            audio.play();
            video.play();
        });

        const togglePlay = () => {
            if (video.paused) {
                video.play();
                audio.play();
            } else {
                video.pause();
                audio.pause();
            }
        };

        // Tap/click to play/pause
        document.querySelector('.player-wrapper').addEventListener('click', (e) => {
            if (e.target.id === 'unmute-overlay' || e.target.closest('#unmute-overlay')) return;
            togglePlay();
        });

        // Keyboard navigation
        window.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight') {
                vscode.postMessage({ type: 'requestNext' });
            } else if (e.key === 'ArrowLeft') {
                vscode.postMessage({ type: 'requestPrevious' });
            } else if (e.key === ' ') { // Space for play/pause
                e.preventDefault();
                togglePlay();
            }
        });

        const updateLoopBehavior = () => {
            if (autoPlayToggle.checked) {
                video.loop = false;
            } else {
                video.loop = true;
            }
        };

        autoPlayToggle.addEventListener('change', () => {
            updateLoopBehavior();
            // If we just turned off autoplay, ensure we are looping if ended
            if (!autoPlayToggle.checked && (video.ended || audio.ended)) {
                video.currentTime = 0;
                audio.currentTime = 0;
                video.play();
                audio.play();
            }
        });

        geminiToggle.addEventListener('change', () => {
            vscode.postMessage({ type: 'toggleFollowGemini', value: geminiToggle.checked });
        });

        categorySelect.addEventListener('change', () => {
            loadingScreen.style.opacity = 1;
            loadingScreen.style.pointerEvents = 'auto';
            vscode.postMessage({ type: 'setCategory', value: categorySelect.value });
        });

        browserBtn.addEventListener('click', () => {
            if (currentCoub) {
                vscode.postMessage({ type: 'openExternal', value: 'https://coub.com/view/' + currentCoub.permalink });
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'loadCoub') {
                loadCoub(message.value);
            } else if (message.type === 'play') {
                video.play();
                audio.play();
            } else if (message.type === 'pause') {
                video.pause();
                audio.pause();
            } else if (message.type === 'toggle') {
                togglePlay();
            } else if (message.type === 'setFollowGemini') {
                geminiToggle.checked = message.value;
                resetOverlayTimer();
            }
        });

        function loadCoub(coub) {
            currentCoub = coub;
            loadingScreen.style.opacity = 0;
            loadingScreen.style.pointerEvents = 'none';
            
            coubTitle.textContent = coub.title || 'Untitled';
            coubMeta.textContent = 'by ' + (coub.channel ? coub.channel.title : 'Anonymous');
            
            // Get URLs
            const videoUrl = coub.file_versions.html5.video.high.url;
            const audioUrl = coub.file_versions.html5.audio.high.url;

            // Stop current
            video.pause();
            audio.pause();
            clearInterval(syncInterval);

            // Load new
            video.src = videoUrl;
            audio.src = audioUrl;
            
            audio.muted = isMuted;
            video.muted = true; // Video is always muted for autoplay

            const startPlayback = () => {
                video.play();
                audio.play();
                if (!isMuted) {
                    unmuteOverlay.classList.add('hidden');
                }
            };

            // Update loop behavior based on current toggle state
            updateLoopBehavior();

            video.oncanplay = startPlayback;

            // Rule 1: If Autoplay is ON, switch exactly when VIDEO ends
            video.onended = () => {
                if (autoPlayToggle.checked) {
                    vscode.postMessage({ type: 'requestNext' });
                }
            };

            // Rule 2: If Autoplay is OFF, audio loops independently
            audio.onended = () => {
                if (!autoPlayToggle.checked) {
                    audio.currentTime = 0;
                    audio.play();
                } else {
                    // If audio ends before video when Autoplay is ON, we might want to loop it or let it stop.
                    // Usually Coubs loop audio until video ends too, but let's keep it simple for now.
                    audio.currentTime = 0;
                    audio.play();
                }
            };
            
            // Sync check (only if video is still playing)
            syncInterval = setInterval(() => {
                if (!video.paused && !video.ended && Math.abs(video.currentTime - (audio.currentTime % (video.duration || 100))) > 0.5) {
                    video.currentTime = audio.currentTime % (video.duration || 100);
                }
            }, 1000);
        }

        // Hide overlays after inactivity
        let overlayTimer;
        function resetOverlayTimer() {
            topOverlay.style.opacity = 1;
            bottomOverlay.style.opacity = 1;
            clearTimeout(overlayTimer);
            overlayTimer = setTimeout(() => {
                topOverlay.style.opacity = 0;
                bottomOverlay.style.opacity = 0;
            }, 3000);
        }

        document.addEventListener('mousemove', resetOverlayTimer);
        resetOverlayTimer();

    </script>
</body>
</html>`;
    }
}
