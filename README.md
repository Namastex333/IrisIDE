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
| Desktop app | Tauri (Rust backend) + TypeScript + React. Electron is the fallback if Tauri gets in the way. |
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
- [ ] Create the Tauri + React + TypeScript project
- [ ] Confirm it builds and opens a blank window
- [ ] Set up the repo, `.gitignore`, and this README
- [ ] Get an Anthropic API key and store it safely (env var or OS keychain, never committed)

### Phase 1: Basic shell
- [ ] Open a project folder
- [ ] Monaco editor pane that opens and saves a file
- [ ] Python syntax highlighting
- [ ] Terminal pane with xterm.js
- [ ] **Run** button that runs the project's entry point and shows output
- [ ] Simple temporary file list (replaced by the tree in Phase 2)

### Phase 2: Structure view (the tree)
- [ ] Parse Python files with tree-sitter to find imports and function calls
- [ ] Build a call graph (files → functions → calls)
- [ ] Draw the graph with React Flow
- [ ] Color-code edges by type (config load, function call, data read/write)
- [ ] Pick an entry point and show only its first-level branches
- [ ] Expand and collapse branches
- [ ] Click a node to open the file in Monaco
- [ ] Closing the editor returns to the tree view
- [ ] Focus mode: fade out everything not connected to the selected node
- [ ] Make the tree the default home screen and remove the file list

### Phase 3: Tracer and run view
- [ ] Write the Python tracer using `sys.monitoring`
- [ ] Record calls, returns, arguments, and exceptions to a trace file
- [ ] Run the project through the tracer when **Run** is pressed
- [ ] Light up executed branches on the tree, in order
- [ ] Show branches that exist but were never reached
- [ ] Keep project files free of any logging code

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
- [ ] Light and dark themes
- [ ] Settings page (entry point, Python path, API key)
- [ ] Use Iris to build Iris 🙂

---

## Getting started

_To be filled in once Phase 1 is done._

```bash
# install dependencies
npm install

# run in development
npm run tauri dev
```

Requirements (planned):
- Node.js
- Rust (for Tauri)
- Python 3.12+ (for the tracer)
- An Anthropic API key

---

## Status

🌱 Early planning. Expect a lot of iteration; that's the workflow this tool is designed for.
