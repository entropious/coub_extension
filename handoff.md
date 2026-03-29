# Coub Extension: Gemini Chat Trigger Findings

## 1. Goal
Automatically expand the panel specifically when Gemini (Antigravity) is used.

## 2. Problem Context
Gemini (Antigravity) Chat operates via a proprietary UI that **does not trigger** standard VS Code command listeners like `vscode.commands.onDidExecuteCommand` during message submission. This makes it impossible to detect chat activity using high-level extension APIs.

## 2. Solution: File System Monitoring (The "fs.watch" Hook)
After investigation, it was confirmed that every user message or model response in Gemini Chat causes an update to a local database/file storage. 

### Path to Conversations
The conversation history is stored as `.pb` (Protocol Buffers) files in the following directory:
`~/.gemini/antigravity/conversations/`

### Implementation Logic
We use the Node.js `fs.watch` module to monitor this specific directory for any file changes. This provides a "zero-lag" trigger immediately after the user sends a message.

### Minimal Code Snippet
```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Resolve the conversation directory
const geminiDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');

if (fs.existsSync(geminiDir)) {
    try {
        // Watch for changes in the directory
        fs.watch(geminiDir, { persistent: false }, (_eventType, filename) => {
            // Check if the modified file is a conversation record (.pb)
            if (filename && filename.endsWith('.pb')) {
                // Trigger panel focus and Coub switch
                handleChatActivity();
            }
        });
    } catch (err) {
        console.error('Failed to attach Gemini watcher:', err);
    }
}
```

## 3. Optimization & Reliability
To prevent system strain and "double-triggering" (especially during multi-step AI responses), the following optimizations were applied:

1. **Persistent: false**: Set `{ persistent: false }` to ensure the watcher doesn't keep the VS Code process alive if it's shutting down.
2. **Throttling (3s)**: A `lastActivityTime` check prevents the extension from skipping multiple Coubs if the `.pb` file is updated several times in rapid succession (common during long AI generation).
   
```typescript
let lastActivityTime = 0;
const handleChatActivity = () => {
    const now = Date.now();
    if (now - lastActivityTime < 3000) return; // 3-second guard
    lastActivityTime = now;

    // Execute panel focus if setting is enabled
    if (isAutoExpandEnabled) {
        vscode.commands.executeCommand('coub-panel.view.focus');
    }
    
    // Switch to next content
    provider.nextCoub();
};
```

## 4. Why this is the "Minimal Change"
- **Low Overhead**: Uses OS-level file system events (FSEvents on macOS), which is extremely efficient.
- **No Dependencies**: Relies solely on Node.js built-ins (`fs`, `path`, `os`).
- **Complete Coverage**: Detects both *new* conversations starting and *continuations* of old ones, as both update files in the same directory.
