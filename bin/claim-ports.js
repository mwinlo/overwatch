#!/usr/bin/env node
// Claim ports for a project and register them with Overwatch.
//
// Usage:
//   node bin/claim-ports.js <project-name> [ENV_VAR:label ...] [--path <dir>] [--command <cmd>] [--group <g>]
//
// Examples:
//   node bin/claim-ports.js ledger PORT
//   node bin/claim-ports.js ledger PORT AUTH_PORT:auth API_PORT:api
//   node bin/claim-ports.js my-new-app PORT --path ~/projects/my-new-app --group apps
//
// If the project is already registered, its primary port is reused.
// Additional ENV_VARs get the next available ports from the registry range.
// All assignments are written to the project's .env.local and registered in Overwatch.

const path = require('path');
const fs = require('fs');
const registry = require('../registry');

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { name: null, vars: [], path: null, command: null, group: null, description: null };

  let i = 0;
  // First positional arg is the project name
  if (args.length > 0 && !args[0].startsWith('--')) {
    result.name = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg === '--path' && args[i + 1]) { result.path = args[++i]; }
    else if (arg === '--command' && args[i + 1]) { result.command = args[++i]; }
    else if (arg === '--group' && args[i + 1]) { result.group = args[++i]; }
    else if (arg === '--description' && args[i + 1]) { result.description = args[++i]; }
    else if (!arg.startsWith('--')) {
      // ENV_VAR or ENV_VAR:label
      const [envVar, label] = arg.split(':');
      result.vars.push({ envVar, label: label || envVar.toLowerCase().replace(/_port$/, '') });
    }
    i++;
  }

  return result;
}

function findAvailablePorts(claimed, count) {
  const ports = [];
  for (let p = registry.PORT_RANGE_START; p <= registry.PORT_RANGE_END && ports.length < count; p++) {
    if (!claimed.has(p)) {
      ports.push(p);
    }
  }
  if (ports.length < count) {
    console.error(`Error: Only ${ports.length} ports available in range ${registry.PORT_RANGE_START}-${registry.PORT_RANGE_END}, need ${count}`);
    process.exit(1);
  }
  return ports;
}

function updateEnvLocal(projectPath, assignments) {
  const envPath = path.join(projectPath, '.env.local');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    // Will create the file
  }

  const lines = content.split('\n');

  for (const { envVar, port } of assignments) {
    const regex = new RegExp(`^${envVar}\\s*=`);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        lines[i] = `${envVar}=${port}`;
        found = true;
        break;
      }
    }
    if (!found) {
      // Add after last PORT-like line, or at the top
      const lastPortIdx = lines.reduce((acc, line, idx) => /^[A-Z_]*PORT\s*=/.test(line) ? idx : acc, -1);
      if (lastPortIdx >= 0) {
        lines.splice(lastPortIdx + 1, 0, `${envVar}=${port}`);
      } else {
        lines.unshift(`${envVar}=${port}`);
      }
    }
  }

  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.name) {
    console.error('Usage: claim-ports <project-name> [ENV_VAR:label ...] [--path <dir>] [--command <cmd>]');
    console.error('');
    console.error('Examples:');
    console.error('  claim-ports ledger PORT');
    console.error('  claim-ports ledger PORT AUTH_PORT:auth API_PORT:api');
    console.error('  claim-ports my-app PORT --path ~/projects/my-app --group apps');
    process.exit(1);
  }

  if (args.vars.length === 0) {
    args.vars.push({ envVar: 'PORT', label: 'main' });
  }

  const reg = registry.ensureRegistry();
  const existing = reg.projects[args.name];
  const claimed = registry.getAllClaimedPorts(reg);

  // Determine project path
  const projectPath = args.path
    || (existing && existing.path)
    || process.cwd();
  const expandedPath = registry.expandPath(projectPath);

  if (!fs.existsSync(expandedPath)) {
    console.error(`Error: Project path does not exist: ${expandedPath}`);
    process.exit(1);
  }

  // Assign ports
  const assignments = [];
  let primaryPort = existing ? existing.port : null;
  const services = (existing && existing.services) ? { ...existing.services } : {};
  let needNew = 0;

  // Count how many new ports we need
  for (const v of args.vars) {
    if (v.envVar === 'PORT' && primaryPort) continue;
    if (services[v.label]) continue;
    needNew++;
  }

  const newPorts = findAvailablePorts(claimed, needNew);
  let newIdx = 0;

  for (const v of args.vars) {
    if (v.envVar === 'PORT') {
      if (!primaryPort) {
        primaryPort = newPorts[newIdx++];
      }
      assignments.push({ envVar: 'PORT', port: primaryPort, label: 'main' });
    } else {
      let port = services[v.label];
      if (!port) {
        port = newPorts[newIdx++];
        services[v.label] = port;
      }
      assignments.push({ envVar: v.envVar, port, label: v.label });
    }
  }

  // Update registry
  reg.projects[args.name] = {
    port: primaryPort,
    path: registry.collapsePath(expandedPath),
    command: args.command || (existing && existing.command) || 'npm run dev',
    group: args.group || (existing && existing.group) || 'apps',
    description: args.description || (existing && existing.description) || '',
    memoryLimitMB: (existing && existing.memoryLimitMB) || 1024,
    ...(Object.keys(services).length > 0 ? { services } : {}),
  };
  registry.writeRegistry(reg);

  // Write to .env.local
  updateEnvLocal(expandedPath, assignments);

  // Print summary
  console.log(`\n  ${args.name} — ports claimed\n`);
  for (const a of assignments) {
    const tag = a.label === 'main' ? '(primary)' : `(${a.label})`;
    console.log(`  ${a.envVar}=${a.port}  ${tag}`);
  }
  console.log(`\n  Written to: ${path.join(expandedPath, '.env.local')}`);
  console.log(`  Registry:   ${registry.REGISTRY_PATH}\n`);
}

main();
