# Coub Extension: Gemini Chat Trigger Findings

## 1. Goal
Automatically expand the panel specifically when Gemini (Antigravity) is used.

## 2. Problem Context
Gemini (Antigravity) Chat operates via a proprietary UI that **does not trigger** standard VS Code command listeners like `vscode.commands.onDidExecuteCommand` during message submission. This makes it impossible to detect chat activity using high-level extension APIs.

## 3. Solution: File System Monitoring (The "fs.watch" Hook)
Every user message or model response in Gemini Chat causes an update to `.pb` (Protocol Buffers) files in:
`~/.gemini/antigravity/conversations/`

### Implementation Logic
We use `fs.watch` to monitor this directory. The logic is encapsulated in the `CoubViewProvider` class for clean lifecycle management.

```typescript
this._geminiWatcher = fs.watch(geminiDir, { persistent: false }, (_eventType, filename) => {
    if (filename && filename.endsWith('.pb')) {
        eventCount++;
        
        // Initial trigger: Focus panel and start playback
        if (!isSessionActive) {
            isSessionActive = true;
            vscode.commands.executeCommand('coub-panel.view.focus');
        }
        this.play();

        if (activityTimer) {
            clearTimeout(activityTimer);
        }

        // Wait longer (8s) for thinking phase, 1.5s for streaming
        const debounceTime = eventCount < 5 ? 8000 : 1500;

        activityTimer = setTimeout(() => {
            isSessionActive = false;
            eventCount = 0;
            this.pause(); // Stop Coub when AI stops talking
            activityTimer = null;
        }, debounceTime);
    }
});
```

## 4. Optimization & Reliability
1. **Persistent: false**: Watcher doesn't keep the VS Code process alive on shutdown.
2. **Dynamic Debounce**: 8s initial window covers AI "thinking" phase; 1.5s window ensures Coub stops promptly after the response finishes.
3. **UI Toggle**: Added "Gemini Sync" switch to the sidebar; the `fs.watch` session is physically closed when disabled.
4. **Lifecycle**: The provider implements `vscode.Disposable` to ensure the watcher is closed on extension deactivation.

## 5. Why this is the "Optimal Change"
- **Low Overhead**: Uses OS-level events.
- **Zero Lag**: Instant detection of chat activity.
- **User Control**: Users can opt-out of the behavior on the fly.
