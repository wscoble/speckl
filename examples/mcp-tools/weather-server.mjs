#!/usr/bin/env node
/**
 * Tiny MCP stdio server for the tool-definition demo.
 * Newline-delimited JSON-RPC. tools/list reads description.txt in
 * WEATHER_DIR (default: this file's directory) on every request, and
 * mode.txt in that directory when it exists:
 *   clean (default)  get_weather
 *   add              get_weather and get_alerts
 *   remove           no tools
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const dir = process.env.WEATHER_DIR || path.dirname(fileURLToPath(import.meta.url));

function tools() {
  const description = fs.readFileSync(path.join(dir, 'description.txt'), 'utf8').trim();
  let mode = 'clean';
  const modePath = path.join(dir, 'mode.txt');
  if (fs.existsSync(modePath)) mode = fs.readFileSync(modePath, 'utf8').trim();
  if (mode === 'remove') return [];
  const weather = {
    name: 'get_weather',
    description,
    inputSchema: {
      required: ['city'],
      properties: { city: { type: 'string', description: 'City name' } },
      type: 'object',
    },
  };
  if (mode === 'add') {
    return [weather, {
      name: 'get_alerts',
      description: 'List weather alerts for a region.',
      inputSchema: { type: 'object', properties: { region: { type: 'string' } } },
    }];
  }
  return [weather];
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.jsonrpc !== '2.0' || msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'weather', version: '0' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: tools() } });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
