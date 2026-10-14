# Iris IDE

**A calm, visual coding IDE for Python with Claude built in. Your project is a living tree of which files call which, not a wall of files.**

---

## Why Iris exists

*Named after the iris of the eye: the part that controls how much light gets in. Iris lets in only what you need to see right now, and the 👁 focus eye is at the center of it.*


Most IDEs show you everything at once: every file, every panel, every log line. That's great for some people and overwhelming for others.

Iris is built around two ideas:

1. **See the project, don't read it.** The main screen is a branching map of how your code connects. The editor only opens when you click into something.
2. **Steer Claude one idea at a time.** Every change Claude proposes arrives as its own card you can keep, reject, or park, so you never have to accept a bundle of changes you only half wanted.

This isn't trying to replace VS Code. It's a personal tool shaped around how projects flow in my head.

---

## Features

### 🌳 The tree view (home screen)
- Your project is shown as a branching map of which files and functions call which.
- Branches are **color-coded by interaction type**, for example:
  - 🔵 loads a config file
  - 🟢 calls a function
  - 🟠 reads or writes data
- You start from a single entry point (like `main`) and expand branches only when you want to. Nothing else is shown until you ask for it.
- **Focus mode:** click any node and everything not connected to it fades out.
- **Feature clusters:** group branches into named chunks like "data fetching," "order logic," or "config." Claude can suggest groupings.
- Every branch can carry a plain-English label from Claude, like *"pulls today's prices and passes them to the strategy."*
- Clicking a node opens that file. Closing it always drops you back to the tree.

### 💡 Run view
- Hit **Run** and the branches that actually executed light up in order.
- A branch you expected to light up but didn't is your bug, found visually.

### 👁 Invisible debugging and the focus eye
- No logging code in your project files. Iris runs your code through a built-in tracer (Python's `sys.monitoring`, 3.12+) that records every call, return value, and error from the outside.
- When something fails:
  - the **failing function turns red**
  - the **calling function turns orange**
  - the branch between them is highlighted
- Click the **👁 focus eye** to isolate just those two functions side by side, with the error message and the actual values that were passed in when it broke.
- Claude reads the trace Iris already collected, so it never needs to add debug lines either.

### ⏪ Clean versions, no `_v2` clutter
- The tree always shows clean file names (`config_github.py`, not `test_config_github_v4.py`).
- Drafts are snapshotted in the background using a hidden git history.
- A **browser-style back/forward arrow** steps between versions of a file.
- A **Finalize** button at the end of a session clears old drafts and saves the file under its intended name.
- Each version is linked to the runs it was part of, so you can see which version worked.

### 🃏 Change cards
- When you give Claude several ideas at once, each one comes back as a **separate card**.
- For each card: **Keep**, **Reject**, or **Park** for later.
- Rejecting a card makes Claude ask a short follow-up question about what you actually meant, so the next attempt lands closer.
- **Drag and drop:** drag cards to decide on them, and drag a function from the editor into the chat to say "this part" without copy-pasting.
- **Labels on every card**, mostly computed by Iris itself at no extra Claude cost:
  - files and functions touched
  - lines added or removed
  - new file vs. edit
  - ran green, ran red, or untested
  - plus a short title, type (*feature / fix / refactor*), and risk level that Claude adds in the same response
- Filter cards by label, e.g. "show me only fixes."

---

## Tech stack

| Part | Tool |
|---|---|
| Desktop app | Electron + TypeScript + React (v1). The UI only talks to the backend through one interface (`src/shared/api.ts`), so a lighter Tauri build stays possible as a v2. |
| Code editor | Monaco (the editor inside VS Code) |
| Terminal pane | xterm.js |
| Tree / branching visual | React Flow |
| Code parsing (finding imports and calls) | tree-sitter (Python grammar) |
| Runtime tracing | Python `sys.monitoring` (3.12+) |
| Version snapshots | Hidden git repository per project |
| Claude integration | Claude Agent SDK (TypeScript) |

> **Note:** The Claude integration needs an Anthropic API key, which is billed per use and is separate from a Claude subscription.

---

## Build checklist

Built in phases so there's something usable early and each phase can be vibecoded on its own.

### Phase 0: Setup
- [x] Create the Electron + React + TypeScript project
- [x] Confirm it builds and opens a window
- [x] Set up the repo, `.gitignore`, and this README
- [x] Package it as an installable app with a Desktop shortcut
- [ ] Get an Anthropic API key and store it safely (env var or OS keychain, never committed). Not needed until Phase 6.

### Phase 1: Basic shell
- [x] Open a project folder
- [x] Monaco editor pane that opens and saves a file
- [x] Python syntax highlighting
- [x] Terminal pane with xterm.js
- [x] **Run** button that runs the project's entry point and shows output
- [x] Simple temporary file list (replaced by the tree in Phase 2)

### Phase 2: Structure view (the tree)
- [x] Parse Python files with tree-sitter to find imports and function calls
- [x] Build a call graph (files → functions → calls)
- [x] Draw the graph with React Flow
- [x] Color-code edges by type (config load, function call, data read/write)
- [x] Pick an entry point and show only its first-level branches
- [x] Expand and collapse branches
- [x] Open a node's file in Monaco, at the function (double-click, or select it and press **Open**; a single click is focus mode)
- [x] Closing the editor returns to the tree view
- [x] Focus mode: fade out everything not connected to the selected node
- [x] Make the tree the default home screen (the file list is now an optional sidebar, off by default, so files the tree does not reach can still be opened)
- [x] List functions and classes the entry point never reaches
- [x] Create a new file from the top bar

### Phase 3: Tracer and run view
- [x] Write the Python tracer using `sys.monitoring`
- [x] Record calls, returns, arguments, and exceptions to a trace file
- [x] Run the project through the tracer when **Run** is pressed
- [x] Light up executed branches on the tree, in order
- [x] Show branches that exist but were never reached
- [x] Keep project files free of any logging code
- [x] Light up config and data branches too, by watching file, database, network and environment access (Python audit hooks)
- [x] Add branches that only show up at run time (for example a callback called from somewhere unexpected)

### Phase 4: Error flagging and the focus eye
- [ ] Turn the failing function red and its caller orange
- [ ] Highlight the branch between them
- [ ] Add the 👁 focus eye button on flagged nodes
- [ ] Focus view: the two functions side by side
- [ ] Show the error message and the input values at the moment of failure

### Phase 5: Version snapshots
- [ ] Create a hidden git repo per project for snapshots
- [ ] Auto-snapshot on save
- [ ] Show only clean file names in the tree
- [ ] Back/forward arrows to step through a file's versions
- [ ] Draft vs. finalized states
- [ ] **Finalize** button: clear drafts and save under the intended name
- [ ] Link each version to the runs it was part of
- [ ] Import tool for existing `test_x.py`, `test_x_v2.py`… files into snapshot history

### Phase 6: Claude integration
- [ ] Claude chat panel using the Claude Agent SDK
- [ ] Give Claude access to the project files and the latest trace
- [ ] Claude writes plain-English labels for branches
- [ ] Claude suggests feature clusters
- [ ] Claude flags suspicious calls (e.g. functions defined but never reached)

### Phase 7: Change cards
- [ ] Split Claude's multi-idea responses into separate change cards
- [ ] Keep / Reject / Park actions per card
- [ ] Apply only kept cards to the code
- [ ] Rejected cards trigger a short probing question from Claude
- [ ] Parked cards list for later
- [ ] Drag-and-drop to decide on cards
- [ ] Drag a function from the editor into the chat
- [ ] Locally computed labels: files touched, lines changed, new vs. edit, run status
- [ ] Claude-written tag line in the same response: title, type, risk
- [ ] Filter and color-tag cards by label
- [ ] Optional: regenerate labels with a cheaper model (Haiku)

### Phase 8: Polish
- [ ] Remember the last open project and tree layout
- [ ] Keyboard shortcuts for the most common actions
- [x] Light and dark themes
- [ ] Colors: lighten the dark theme a little, and replace the purple and blue accents with a complementary orange
- [x] Settings page (theme, tree options, editor and terminal fonts, Python path, entry point)
- [ ] API key in Settings (comes with Phase 6)
- [ ] Use Iris to build Iris 🙂

---

## Getting started

Requirements:
- Node.js 22.12 or newer
- Python 3.12+ on your PATH (used by **Run** and the tracer; older versions run, but untraced)
- An Anthropic API key (only from Phase 6 onward)

```bash
# install dependencies (once)
npm install
npx install-electron

# run in development, with live reload
npm run dev

# check types
npm run typecheck
```

### Build the desktop app

```bash
npm run dist
```

This creates `release/Iris-Setup-<version>.exe` (close Iris first if it is open). Run it to install Iris for your user account (no admin needed) and put an **Iris** shortcut on the Desktop and in the Start menu. After changing the code, run `npm run dist` and the installer again to update the installed app. To remove it, use Windows Settings → Apps → Iris.

The installed app and `npm run dev` keep separate settings, so both can be open at once.

### Using it

1. **Open Folder** and pick a Python project (`examples/hello` is a tiny one to try). In an empty folder, **New File** creates your first file.
2. The tree starts at the **entry point**, the file you run. It is `main.py` if the project has one; pick a different file with the **Entry** dropdown in the top bar.
3. In the tree:
   - the round button on a node shows how many branches it has; click it to expand or collapse
   - **click** a node for focus mode (everything unconnected fades); click the background to clear it
   - **double-click** a node, or select it and press **Open**, to edit its file at that function
   - **← Tree** closes the editor and returns to the tree exactly as you left it
   - **N not reached** lists functions and classes the entry point never gets to
4. **Ctrl+S** saves; a dot on the tab means unsaved changes. The tree updates after each save.
5. **Run** runs the entry point and shows its output in the Run tab. The Terminal tab is a PowerShell session in the project folder.
6. While it runs, the tree lights up the branches that run, in the order they first run. Afterwards:
   - lit branches ran; dim ones did not, and nodes say how many times they ran
   - the bar above the tree says how the run went and how many branches ran
   - **Show what ran** opens exactly the branches that ran, **Replay** lights them up again in order, **✕** clears the run
   - a collapsed node with a green count has branches inside that ran
7. **⚙** (or **Ctrl+,**) opens Settings: theme, tree direction, fonts, the Python interpreter, tracing on or off, and more. **Files** shows a plain list of every file.

### How to read the tree

| Branch | Meaning |
|---|---|
| 🟢 green | calls a function, method or class |
| 🔵 blue | loads config: reads a `.json` / `.yaml` / `.toml` / `.ini` / `.env` file, or environment variables |
| 🟠 orange | reads or writes data: other files, databases, web requests |
| ⚪ gray | imports a module whose top-level code does something |
| dashed | a likely link Iris cannot be sure of: a callback passed as an argument, a framework decorator such as `@app.route`, or a method matched by name |

Before a run, the tree comes from reading the code, so it is a best effort. Code that picks what to call at run time (for example `getattr`, or functions stored in dictionaries) only shows up once it has run. After a run, lit branches are facts: the tracer saw them happen.

### How tracing works

**Run** starts your script through a small tracer (`resources/tracer/iris_tracer.py`) that watches from the outside using Python's `sys.monitoring` and audit hooks. Nothing is added to your files, and the output in the Run tab is exactly what plain Python prints. The tracer records calls, arguments, return values and exceptions in your own code (not in libraries), plus the files, databases, hosts and environment variables your code touches.

Each run's trace is saved in a hidden `.iris/traces` folder inside the project (the last 10 are kept). That folder has its own `.gitignore`, so it never gets committed, and it is safe to delete. A function called hundreds of thousands of times stops being watched after 200,000 calls, so a busy loop does not slow the run down much.

### Project layout

| Path | What lives there |
|---|---|
| `src/shared/api.ts` | The one interface between the UI and the backend |
| `src/main/` | Backend (Electron main process): files, terminal, running Python, settings |
| `src/main/services/analyzer/` | Reads the Python code with tree-sitter and builds the graph behind the tree |
| `src/preload/` | Exposes the interface to the UI as `window.iris` |
| `src/renderer/` | The UI (React, Monaco, xterm.js, React Flow) |
| `src/renderer/src/tree/layout.ts` | Decides which nodes are visible and where they sit |
| `resources/tracer/iris_tracer.py` | The Python tracer that **Run** goes through (its header documents the trace format) |
| `src/main/services/trace-tail.ts` | Reads the trace file while the program is still running |
| `src/renderer/src/tree/trace.ts` | Matches what ran to the tree's nodes and branches |
| `scripts/make-icon.mjs` | Draws the app icon into `resources/icon.png` (`npm run icon`) |

---

## Status

🌿 Phases 0 to 3 are done: Iris installs, opens a project as a tree of what calls what, edits and saves files, has a terminal and a settings page, and runs Python through a tracer that lights up the branches that actually ran. Next up is Phase 4, error flagging and the focus eye. Expect a lot of iteration; that's the workflow this tool is designed for.
