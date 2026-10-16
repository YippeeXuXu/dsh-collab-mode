#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const SPEC_FILE = path.join(ROOT_DIR, 'governance', 'spec.md');
const KERNEL_FILE = path.join(ROOT_DIR, 'governance', 'planner-kernel.md');
const AGENT_FILE = path.join(ROOT_DIR, 'agent.cordis.yml');
const HASH_FILE = path.join(ROOT_DIR, 'governance', 'projection-hashes.json');

const BEGIN_MARKER = '# ===== PLANNER-KERNEL BEGIN =====';
const END_MARKER = '# ===== PLANNER-KERNEL END =====';
const KERNEL_TITLE = '# DSH 协作模式 Planner Persona v4.3（常驻运行投影）';
function fail(message) {
  throw new Error(message);
}
function readUtf8(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail(`${path.relative(ROOT_DIR, file)} is not valid UTF-8`);
  }
  return { bytes, text };
}

function normalizeText(text) {
  const nfc = text.normalize('NFC');
  const lf = nfc.replace(/\r\n?/gu, '\n');
  const withoutTrailingWhitespace = lf
    .split('\n')
    .map((line) => line.replace(/[^\S\r\n]+$/gu, ''))
    .join('\n');
  return `${withoutTrailingWhitespace.replace(/\n+$/u, '')}\n`;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function lineEndingAt(text, offset) {
  if (text.startsWith('\r\n', offset)) return '\r\n';
  if (text[offset] === '\n') return '\n';
  if (text[offset] === '\r') return '\r';
  return '';
}

function consumeLineEnding(text, offset) {
  const ending = lineEndingAt(text, offset);
  return offset + ending.length;
}

function lineRecords(text) {
  const records = [];
  let start = 0;
  while (start < text.length) {
    let cursor = start;
    while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
    const contentEnd = cursor;
    const ending = lineEndingAt(text, cursor);
    records.push({
      start,
      end: consumeLineEnding(text, cursor),
      content: text.slice(start, contentEnd),
      ending,
    });
    start = consumeLineEnding(text, cursor);
  }
  if (text.length === 0 || /(?:\n|\r\n?)$/u.test(text)) {
    records.push({ start: text.length, end: text.length, content: '', ending: '' });
  }
  return records;
}

function leadingWhitespace(line) {
  return line.match(/^[ \t]*/u)?.[0] ?? '';
}

function locatePersona(yml) {
  const records = lineRecords(yml);
  const personaIndex = records.findIndex(({ content }) => /^-\s+id:\s*persona\s*$/u.test(content));
  if (personaIndex < 0) fail('agent.cordis.yml does not contain the persona entry');
  const personaIndent = leadingWhitespace(records[personaIndex].content).length;

  let nextRootIndex = records.length;
  for (let index = personaIndex + 1; index < records.length; index += 1) {
    const content = records[index].content;
    if (/^\s*-\s+id:\s*[^\s].*$/u.test(content)
      && leadingWhitespace(content).length <= personaIndent) {
      nextRootIndex = index;
      break;
    }
  }

  const textIndex = records.findIndex((record, index) => (
    index > personaIndex
    && index < nextRootIndex
    && /^([ \t]*)text:\s*\|[ \t]*$/u.test(record.content)
  ));
  if (textIndex < 0) fail('persona entry does not contain a text block');

  const textIndent = leadingWhitespace(records[textIndex].content);
  return {
    records,
    personaIndex,
    textIndex,
    nextRootIndex,
    textStart: records[textIndex].end,
    textIndent,
    scalarIndent: `${textIndent}  `,
    scalarEnd: records[nextRootIndex]?.start ?? yml.length,
  };
}

function markerMatches(yml) {
  const matches = [];
  for (const marker of [BEGIN_MARKER, END_MARKER]) {
    const expression = new RegExp(`^([ \\t]*)${escapeRegExp(marker)}[ \\t]*\\r?$`, 'gmu');
    matches.push({
      marker,
      entries: [...yml.matchAll(expression)].map((match) => ({
        index: match.index,
        length: match[0].length,
        indent: match[1],
        lineEnd: consumeLineEnding(yml, match.index + match[0].length),
      })),
    });
  }
  return Object.fromEntries(matches.map(({ marker, entries }) => [marker, entries]));
}

function markerBlock(yml, persona) {
  const matches = markerMatches(yml);
  const begins = matches[BEGIN_MARKER] ?? [];
  const ends = matches[END_MARKER] ?? [];
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1) {
    fail(`expected exactly one planner-kernel BEGIN and END marker (found ${begins.length}/${ends.length})`);
  }

  const begin = begins[0];
  const end = ends[0];
  if (begin.index < persona.textStart || begin.index >= persona.scalarEnd
    || end.index <= begin.index || end.index > persona.scalarEnd) {
    fail('planner-kernel markers are outside the persona text block');
  }
  if (begin.indent !== end.indent) fail('planner-kernel marker indentation differs');

  const contentStart = begin.lineEnd;
  const contentEnd = end.index;
  const segment = yml.slice(contentStart, contentEnd);
  const lines = segment.split(/\n/gu);
  for (const line of lines) {
    const lineWithoutCr = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (lineWithoutCr !== '' && !lineWithoutCr.startsWith(begin.indent)) {
      fail('planner-kernel embedded content is not consistently indented');
    }
  }
  const indentExpression = new RegExp(`^${escapeRegExp(begin.indent)}`, 'gmu');
  const embedded = segment.replace(indentExpression, '');
  return {
    begin,
    end,
    indent: begin.indent,
    contentStart,
    contentEnd,
    embedded,
  };
}

function findKernelStart(yml, persona) {
  const titleExpression = new RegExp(`^[ \\t]*${escapeRegExp(KERNEL_TITLE)}[ \\t]*\\r?$`, 'mu');
  const match = titleExpression.exec(yml.slice(persona.textStart, persona.scalarEnd));
  if (!match) fail('cannot locate the existing planner-kernel text inside persona');
  return persona.textStart + match.index;
}

function indentKernel(kernelText, indent) {
  return kernelText.replace(/^(?!$)/gmu, indent);
}

function preferredNewline(yml, start = 0) {
  const match = /\r\n|\n|\r/u.exec(yml.slice(start));
  return match?.[0] ?? '\n';
}

function buildEmbeddedBlock(kernelText, indent, newline) {
  const indentedKernel = indentKernel(kernelText, indent);
  const separator = kernelText.endsWith('\n') ? '' : newline;
  return `${indent}${BEGIN_MARKER}${newline}${indentedKernel}${separator}${indent}${END_MARKER}`;
}

function synchronizeKernel(yml, kernelText) {
  const persona = locatePersona(yml);
  const existing = markerBlock(yml, persona);
  const newline = preferredNewline(yml, persona.textStart);
  if (existing) {
    const replacement = buildEmbeddedBlock(kernelText, existing.indent, newline);
    return `${yml.slice(0, existing.begin.index)}${replacement}${yml.slice(existing.end.length + existing.end.index)}`;
  }

  const kernelStart = findKernelStart(yml, persona);
  const replacement = `${buildEmbeddedBlock(kernelText, persona.scalarIndent, newline)}${newline}`;
  return `${yml.slice(0, kernelStart)}${replacement}${yml.slice(persona.scalarEnd)}`;
}

function readHashes() {
  let value;
  try { value = JSON.parse(readFileSync(HASH_FILE, 'utf8')); } catch (error) { fail(`cannot read ${path.relative(ROOT_DIR, HASH_FILE)}: ${error.message}`); }
  if (!value || value.hash_scheme !== 'normalized-text-sha256-v1'
    || !/^[0-9a-f]{64}$/u.test(value.spec_sha256 ?? '')
    || !/^[0-9a-f]{64}$/u.test(value.kernel_sha256 ?? '')) {
    fail('projection-hashes.json has invalid schema');
  }
  return value;
}

function firstByteDifference(left, right) {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < limit; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return `byte ${index}: embedded=0x${leftBytes[index].toString(16).padStart(2, '0')} kernel=0x${rightBytes[index].toString(16).padStart(2, '0')}`;
    }
  }
  if (leftBytes.length !== rightBytes.length) {
    return `length differs: embedded=${leftBytes.length} bytes kernel=${rightBytes.length} bytes`;
  }
  return 'content differs';
}

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;
  let mode = 0o644;
  try { mode = statSync(file).mode & 0o777; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  try {
    writeFileSync(temporary, content, 'utf8');
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Keep the original error; cleanup is best effort.
    }
    throw error;
  }
}

function loadInputs() {
  const spec = readUtf8(SPEC_FILE);
  const kernel = readUtf8(KERNEL_FILE);
  const agent = readUtf8(AGENT_FILE);
  return { spec, kernel, agent };
}

function verifyProjection({ spec, kernel, agent }) {
  const specHash = sha256(normalizeText(spec.text));
  const kernelHash = sha256(normalizeText(kernel.text));
  const declared = readHashes();
  const persona = locatePersona(agent.text);
  const block = markerBlock(agent.text, persona);
  if (!block) fail('agent.cordis.yml is missing planner-kernel BEGIN/END markers');

  const failures = [];
  if (specHash !== declared.spec_sha256) {
    failures.push(`spec_sha256 mismatch: spec=${specHash} declared=${declared.spec_sha256}`);
  }
  if (kernelHash !== declared.kernel_sha256) {
    failures.push(`kernel_sha256 mismatch: kernel=${kernelHash} declared=${declared.kernel_sha256}`);
  }
  if (block.embedded !== kernel.text) {
    failures.push(`embedded planner-kernel mismatch: ${firstByteDifference(block.embedded, kernel.text)}`);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    fail(`release-sync verification failed (${failures.length} issue${failures.length === 1 ? '' : 's'})`);
  }

  console.log(`[OK] spec_sha256 = ${specHash}`);
  console.log(`[OK] kernel_sha256 = ${kernelHash}`);
  console.log(`[OK] embedded planner-kernel matches governance/planner-kernel.md (${Buffer.byteLength(kernel.text, 'utf8')} bytes)`);
  console.log('release-sync verify: OK');
}

function synchronize() {
  const inputs = loadInputs();
  const specHash = sha256(normalizeText(inputs.spec.text));
  const kernelHash = sha256(normalizeText(inputs.kernel.text));
  const hashes = { hash_scheme: 'normalized-text-sha256-v1', spec_sha256: specHash, kernel_sha256: kernelHash };
  let updated = inputs.agent.text.replace(/^      (?:norm_sha256|runtime_projection_sha256|hash_scheme):.*(?:\r?\n|$)/gmu, '');
  updated = synchronizeKernel(updated, inputs.kernel.text);
  if (updated !== inputs.agent.text) atomicWrite(AGENT_FILE, updated);
  atomicWrite(HASH_FILE, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(`release-sync: synchronized ${path.relative(ROOT_DIR, AGENT_FILE)}`);
  console.log(`release-sync: updated ${path.relative(ROOT_DIR, HASH_FILE)}`);
  console.log(`[OK] spec_sha256 = ${specHash}`);
  console.log(`[OK] kernel_sha256 = ${kernelHash}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--verify')) {
    fail('usage: node scripts/release-sync.mjs [--verify]');
  }
  if (args[0] === '--verify') {
    verifyProjection(loadInputs());
  } else {
    synchronize();
  }
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
