import * as vscode from 'vscode';
import * as fs from 'fs';
import * as claudeHooks from './claudeHooks';


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
        vscode.commands.registerCommand('coub-panel.toggle-claude-sync', () => {
            provider.toggleClaudeSync();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('coub-panel.open-in-tab', () => {
            provider.openInTab();
        })
    );
}

/**
 * One player: a webview with a feed, a history and a category of its own. The
 * panel and the editor tab each run their own, so browsing in one leaves the
 * other where it was; playback is all they share.
 */
class CoubPlayer {
    private _coubQueue: any[] = [];
    private _history: any[] = [];
    private _historyIndex: number = -1;
    private _currentCategory: string = 'random';
    private _page: number = 1;

    constructor(
        private readonly _webview: vscode.Webview,
        private readonly _owner: CoubViewProvider
    ) {
        this._webview.onDidReceiveMessage((data) => this._handleMessage(data));
    }

    private async _handleMessage(data: any) {
        switch (data.type) {
            case 'webviewReady':
                this.post({ type: 'setFollowClaude', value: this._owner.followClaudeEnabled });
                await this.nextCoub();
                break;
            case 'requestNext':
                await this.nextCoub();
                break;
            case 'requestPrevious':
                await this.previousCoub();
                break;
            case 'toggleFollowClaude':
                this._owner.setClaudeSync(data.value);
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
            case 'openInTab':
                this._owner.openInTab();
                break;
        }
    }

    public post(message: any) {
        this._webview.postMessage(message);
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

    public refreshFeed() {
        this._coubQueue = [];
        this._page = 1;
        this.nextCoub();
    }

    /** Pauses playback on behalf of `reason`, unless the viewer paused by hand. */
    public autoPause(reason: string) {
        this.post({ type: 'autoPause', reason });
    }

    /** Drops `reason`; playback resumes once nothing else holds it paused. */
    public autoResume(reason: string) {
        this.post({ type: 'autoResume', reason });
    }

    public togglePlay() {
        this.post({ type: 'toggle' });
    }

    private _showCoub(coub: any) {
        if (coub) {
            this.post({ type: 'loadCoub', value: coub });
        }
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
}

class CoubViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'coub-panel.view';
    private _view?: vscode.WebviewView;
    private _panelPlayer?: CoubPlayer;
    private _tabPanel?: vscode.WebviewPanel;
    private _tabPlayer?: CoubPlayer;
    public followClaudeEnabled: boolean = false;
    private _claudeWatcher?: fs.FSWatcher;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this.followClaudeEnabled = this._context.globalState.get<boolean>('followClaude', false);
        if (this.followClaudeEnabled) {
            this.enableClaudeSync();
        }

        this._context.subscriptions.push(
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused) {
                    this.autoResume('window');
                } else {
                    this.autoPause('window');
                }
            })
        );
    }

    public dispose() {
        this.stopClaudeWatcher();
    }

    /** Installs the Claude Code hooks (if missing) and starts following the state they write. */
    private enableClaudeSync() {
        try {
            if (!claudeHooks.hooksInstalled()) {
                claudeHooks.installHooks();
            } else {
                claudeHooks.writeHookScript();
            }
        } catch (err) {
            console.error('Failed to install Claude hooks:', err);
            vscode.window.showErrorMessage(`Coub Panel: could not install Claude Code hooks (${err})`);
            return;
        }

        this.startClaudeWatcher();
    }

    public startClaudeWatcher() {
        if (this._claudeWatcher) {
            return;
        }

        try {
            this._claudeWatcher = fs.watch(claudeHooks.stateDir, { persistent: false }, (_eventType, filename) => {
                if (filename === claudeHooks.stateFileName) {
                    this.applyClaudeState();
                }
            });
        } catch (err) {
            console.error('Failed to attach Claude watcher:', err);
        }
    }

    public stopClaudeWatcher() {
        if (this._claudeWatcher) {
            this._claudeWatcher.close();
            this._claudeWatcher = undefined;
        }
    }

    private applyClaudeState() {
        if (claudeHooks.readState() === 'busy') {
            this.autoResume('claude');
        } else {
            this.autoPause('claude');
        }
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(false);
        this._panelPlayer = new CoubPlayer(webviewView.webview, this);

        webviewView.onDidChangeVisibility(() => this._applyPlaybackRights());
        this._applyPlaybackRights();
    }

    /** Opens the player in an editor tab, or brings the open one forward. */
    public openInTab() {
        if (this._tabPanel) {
            this._tabPanel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'coub-panel.tab',
            'Coub Player',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri]
            }
        );
        panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.png');

        this._tabPanel = panel;
        panel.webview.html = this._getHtmlForWebview(true);
        this._tabPlayer = new CoubPlayer(panel.webview, this);

        panel.onDidChangeViewState(() => this._applyPlaybackRights());
        panel.onDidDispose(() => {
            this._tabPanel = undefined;
            this._tabPlayer = undefined;
            vscode.commands.executeCommand('setContext', 'coub-panel.tabOpen', false);
            this._applyPlaybackRights();
        });

        vscode.commands.executeCommand('setContext', 'coub-panel.tabOpen', true);
        this._applyPlaybackRights();
    }

    /**
     * Only a player on screen plays, and a tab in view outranks the panel, so
     * the two never talk over each other. Neither one overrides a pause the
     * viewer set by hand.
     */
    private _applyPlaybackRights() {
        const tabInView = Boolean(this._tabPanel?.visible);

        if (this._panelPlayer) {
            if (this._view?.visible) {
                this._panelPlayer.autoResume('hidden');
            } else {
                this._panelPlayer.autoPause('hidden');
            }

            if (tabInView) {
                this._panelPlayer.autoPause('tab');
            } else {
                this._panelPlayer.autoResume('tab');
            }
        }

        if (this._tabPlayer) {
            if (tabInView) {
                this._tabPlayer.autoResume('hidden');
            } else {
                this._tabPlayer.autoPause('hidden');
            }
        }
    }

    private get _players(): CoubPlayer[] {
        return [this._panelPlayer, this._tabPlayer].filter((p): p is CoubPlayer => Boolean(p));
    }

    /** The player a command acts on: the tab while it is the one in focus. */
    private get _activePlayer(): CoubPlayer | undefined {
        if (this._tabPanel?.active && this._tabPlayer) {
            return this._tabPlayer;
        }
        if (this._view?.visible && this._panelPlayer) {
            return this._panelPlayer;
        }
        return this._tabPlayer ?? this._panelPlayer;
    }

    public async nextCoub() {
        await this._activePlayer?.nextCoub();
    }

    public async previousCoub() {
        await this._activePlayer?.previousCoub();
    }

    public refreshFeed() {
        this._activePlayer?.refreshFeed();
    }

    public togglePlay() {
        this._activePlayer?.togglePlay();
    }

    /** Pauses playback on behalf of `reason`, unless the viewer paused by hand. */
    public autoPause(reason: string) {
        for (const player of this._players) {
            player.autoPause(reason);
        }
    }

    /** Drops `reason`; playback resumes once nothing else holds it paused. */
    public autoResume(reason: string) {
        for (const player of this._players) {
            player.autoResume(reason);
        }
        // A reason the tab or the panel is still held by must survive the drop.
        this._applyPlaybackRights();
    }

    public toggleClaudeSync() {
        this.setClaudeSync(!this.followClaudeEnabled);
    }

    public setClaudeSync(value: boolean) {
        this.followClaudeEnabled = value;
        this._context.globalState.update('followClaude', this.followClaudeEnabled);

        if (this.followClaudeEnabled) {
            this.enableClaudeSync();
        } else {
            this.stopClaudeWatcher();
            this.autoResume('claude');
            try {
                claudeHooks.uninstallHooks();
            } catch (err) {
                console.error('Failed to remove Claude hooks:', err);
            }
        }

        for (const player of this._players) {
            player.post({ type: 'setFollowClaude', value: this.followClaudeEnabled });
        }
    }

    private _getHtmlForWebview(inTab: boolean) {
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
            display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto;
            gap: 8px;
            align-items: center;
            z-index: 100;
            transition: opacity 0.3s;
        }

        .overlay .switches {
            justify-self: center;
        }

        /* Set when the three groups no longer fit one row: the switches drop below. */
        .overlay.compact .category {
            grid-column: 1;
        }

        .overlay.compact .actions {
            grid-column: 3;
        }

        .overlay.compact .switches {
            grid-row: 2;
            grid-column: 1 / -1;
            justify-self: stretch;
            justify-content: space-between;
            /* The label starts where the select's own text does; the right switch
               ends flush with the edge of the button above it. */
            padding-left: 6px;
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
            gap: 12px;
            align-items: center;
            min-width: 0;
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
            flex-shrink: 0;
            white-space: nowrap;
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
            flex-shrink: 0;
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
            white-space: nowrap;
        }

        /* Glassmorphism Slider Toggle */
        .switch {
            position: relative;
            display: inline-block;
            flex: 0 0 34px;
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
            <div class="controls category">
                <select id="category-select">
                    <option value="hot">Hot</option>
                    <option value="random" selected>Random</option>
                    <option value="rising">Rising</option>
                    <option value="fresh">Fresh</option>
                </select>
            </div>
            <div class="controls switches">
                <div class="auto-play-container" title="Play while Claude Code is working (via Claude hooks)">
                    <span>Claude Sync</span>
                    <label class="switch">
                        <input type="checkbox" id="claude-toggle">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="auto-play-container" title="Advance to the next coub when the track ends">
                    <span>Auto-Play</span>
                    <label class="switch">
                        <input type="checkbox" id="auto-play-toggle" checked>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
            <div class="controls actions">
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
                <div class="controls">
                    ${inTab ? '' : '<button id="tab-btn" title="Open a player in an editor tab">⧉ Tab</button>'}
                    <button id="browser-btn">🌐 View</button>
                </div>
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
        const claudeToggle = document.getElementById('claude-toggle');
        const loadingScreen = document.getElementById('loading-screen');
        const coubTitle = document.getElementById('coub-title');
        const coubMeta = document.getElementById('coub-meta');
        const browserBtn = document.getElementById('browser-btn');
        const topOverlay = document.getElementById('top-overlay');
        const bottomOverlay = document.getElementById('bottom-overlay');

        let currentCoub = null;
        let isMuted = true;
        let syncInterval = null;

        // The switches move to their own row once the three groups stop fitting
        // one line, measured rather than guessed from a breakpoint, so the panel
        // width, the font size and the editor zoom all count.
        const switchesGroup = topOverlay.querySelector('.switches');
        const categoryGroup = topOverlay.querySelector('.category');
        const actionsGroup = topOverlay.querySelector('.actions');

        const updateOverlayLayout = () => {
            topOverlay.classList.remove('compact');
            const style = getComputedStyle(topOverlay);
            const gap = parseFloat(style.columnGap) || 0;
            const available = topOverlay.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            const needed = categoryGroup.offsetWidth + switchesGroup.offsetWidth + actionsGroup.offsetWidth + gap * 2;
            if (needed > available) {
                topOverlay.classList.add('compact');
            }
        };

        new ResizeObserver(updateOverlayLayout).observe(document.body);
        updateOverlayLayout();

        vscode.postMessage({ type: 'webviewReady' });

        const previousBtn = document.getElementById('previous-btn');
        previousBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'requestPrevious' });
        });

        nextBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'requestNext' });
        });

        // A pause set by hand outranks every automatic one: Claude and the window
        // focus may hold their own reasons, but none of them resumes a video the
        // viewer stopped, and clearing them never overrides that choice.
        let pausedByHand = false;
        const autoPauseReasons = new Set();

        const startMedia = () => {
            video.play();
            audio.play();
        };

        const stopMedia = () => {
            video.pause();
            audio.pause();
        };

        const shouldPlay = () => !pausedByHand && autoPauseReasons.size === 0;

        const setPlayingByHand = (playing) => {
            pausedByHand = !playing;
            if (playing) {
                autoPauseReasons.clear();
                startMedia();
            } else {
                stopMedia();
            }
        };

        const autoPause = (reason) => {
            if (pausedByHand) {
                return;
            }
            autoPauseReasons.add(reason);
            stopMedia();
        };

        const autoResume = (reason) => {
            autoPauseReasons.delete(reason);
            if (shouldPlay()) {
                startMedia();
            }
        };

        unmuteOverlay.addEventListener('click', () => {
            isMuted = false;
            unmuteOverlay.classList.add('hidden');
            audio.muted = false;
            video.muted = true;
            setPlayingByHand(true);
        });

        const togglePlay = () => setPlayingByHand(video.paused);

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
            if (!autoPlayToggle.checked && (video.ended || audio.ended) && shouldPlay()) {
                video.currentTime = 0;
                audio.currentTime = 0;
                startMedia();
            }
        });

        claudeToggle.addEventListener('change', () => {
            vscode.postMessage({ type: 'toggleFollowClaude', value: claudeToggle.checked });
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

        const tabBtn = document.getElementById('tab-btn');
        if (tabBtn) {
            tabBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'openInTab' });
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'loadCoub') {
                loadCoub(message.value);
            } else if (message.type === 'autoPause') {
                autoPause(message.reason);
            } else if (message.type === 'autoResume') {
                autoResume(message.reason);
            } else if (message.type === 'toggle') {
                togglePlay();
            } else if (message.type === 'setFollowClaude') {
                claudeToggle.checked = message.value;
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
                if (shouldPlay()) {
                    startMedia();
                }
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
