# Overwatch

Local monitoring dashboard for Claude Code sessions on macOS. See which sessions are eating your RAM and kill them before your Mac locks up.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Open [http://localhost:4040](http://localhost:4040)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `4040`  | Server port |

## Notes

- **macOS only** — uses `ps`, `vm_stat`, `sysctl`, and `lsof` for metrics collection
- **Full Disk Access** may be needed in System Settings > Privacy & Security for `lsof` to read working directories of some processes
- Token counts and cost estimates are approximate — based on conversation log file parsing
- No authentication — designed for local use only
