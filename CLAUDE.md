# Overwatch

Local monitoring dashboard for Claude Code sessions on macOS. Tracks running dev servers, port usage, and system resource consumption.

## Tech Stack

- Node.js (Express + WebSocket)
- Vanilla HTML/JS frontend

## Cross-project knowledge base

- At the start of each session, scan `/Users/apollo/Documents/codeProjects/dev-knowledge/index.md` for known issues relevant to this project's stack and dependencies.
- If you discover a bug, workaround, performance fix, or non-obvious solution that could affect other projects, add it to the knowledge base:
  1. Copy `/Users/apollo/Documents/codeProjects/dev-knowledge/templates/learning-template.md`
  2. Save as `/Users/apollo/Documents/codeProjects/dev-knowledge/learnings/[descriptive-name].md`
  3. Update `/Users/apollo/Documents/codeProjects/dev-knowledge/index.md` with the new entry
- When adding a new learning, tag it accurately so other sessions can find it.
- Slash commands: `/oracle` queries the knowledge base for relevant learnings. `/remember` captures a new learning from the current session.
