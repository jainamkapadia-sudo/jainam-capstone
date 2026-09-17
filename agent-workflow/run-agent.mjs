#!/usr/bin/env node
// Medicine-validator agent: perceive -> reason -> act -> observe (loop), chaining the
// medicine-validator Skill with two real MCP servers (filesystem + GitHub) into one
// end-to-end run against a real sample input.
//
// Usage:
//   node agent-workflow/run-agent.mjs             # full run, opens a real GitHub issue if severity is high
//   node agent-workflow/run-agent.mjs --dry-run   # same reasoning/report, skips the GitHub issue

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');
const SKILL_DIR = path.join(REPO_ROOT, '.claude', 'skills', 'medicine-validator');
const REPORT_PATH = path.join(OUTPUT_DIR, 'validation-report.md');
const GITHUB_REPO = 'jainamkapadia-sudo/jainam-capstone';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const DRY_RUN = process.argv.includes('--dry-run');
// Windows resolves `npx` to `npx.cmd`; spawning the bare name without a shell throws ENOENT.
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function githubToken() {
  try {
    return execSync('gh auth token', { encoding: 'utf-8' }).trim();
  } catch (err) {
    console.warn('[setup] Could not read a gh auth token — GitHub MCP calls will fail:', err.message);
    return '';
  }
}

const FILESYSTEM_MCP = {
  command: NPX_CMD,
  args: ['-y', '@modelcontextprotocol/server-filesystem', DATA_DIR, OUTPUT_DIR, SKILL_DIR]
};

const GITHUB_MCP = {
  command: NPX_CMD,
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken() }
};

const transcript = [];
function log(line) {
  console.log(line);
  transcript.push(line);
}

let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCostUsd = 0;

async function runPhase(name, prompt, options) {
  log(`\n=== PHASE: ${name} ===`);
  log(`[prompt] ${prompt.length > 220 ? prompt.slice(0, 220) + ' …' : prompt}`);

  let finalText = '';
  const q = query({
    prompt,
    options: {
      cwd: REPO_ROOT,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 8,
      ...options
    }
  });

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          log(`[${name}:assistant] ${block.text}`);
          finalText += block.text;
        } else if (block.type === 'tool_use') {
          log(`[${name}:tool_use] ${block.name} ${JSON.stringify(block.input).slice(0, 300)}`);
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          log(`[${name}:tool_result] ${text.slice(0, 300)}`);
        }
      }
    } else if (msg.type === 'result') {
      log(`[${name}:result] is_error=${msg.is_error} turns=${msg.num_turns} cost=$${(msg.total_cost_usd ?? 0).toFixed(4)}`);
      if (msg.usage) {
        totalInputTokens += msg.usage.input_tokens || 0;
        totalOutputTokens += msg.usage.output_tokens || 0;
      }
      totalCostUsd += msg.total_cost_usd || 0;
      if (msg.subtype === 'success') finalText = msg.result;
    }
  }
  return finalText;
}

function extractJson(text) {
  let jsonStr = text;
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1];
  return JSON.parse(jsonStr.trim());
}

async function main() {
  log(`Medicine-Validator Agent — perceive -> reason -> act -> observe`);
  log(`Dry run: ${DRY_RUN}`);
  log(`Repo root: ${REPO_ROOT}`);

  // ---- PERCEIVE ----
  await runPhase(
    'PERCEIVE',
    `Read the file "${path.join(DATA_DIR, 'sample-scan.json')}" and the file "${path.join(SKILL_DIR, 'reference-drugs.json')}" using your filesystem tools. Reply with one short sentence stating how many medications and how many reference drugs you found.`,
    {
      mcpServers: { filesystem: FILESYSTEM_MCP },
      disallowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      skills: []
    }
  );

  // ---- REASON ----
  const scanJson = readFileSync(path.join(DATA_DIR, 'sample-scan.json'), 'utf-8');
  const refJson = readFileSync(path.join(SKILL_DIR, 'reference-drugs.json'), 'utf-8');

  const reasonPrompt = `Use the medicine-validator skill to validate this scanned prescription against the reference drug data below.

Scanned prescription JSON:
${scanJson}

Reference drug data JSON:
${refJson}

Return ONLY the JSON verdict object described by the skill — no markdown fences, no commentary.`;

  const reasonText = await runPhase('REASON', reasonPrompt, {
    skills: ['medicine-validator'],
    disallowedTools: ['Bash']
  });

  let verdict;
  try {
    verdict = extractJson(reasonText);
  } catch (err) {
    log(`[REASON] Failed to parse verdict JSON: ${err.message}`);
    log(`[REASON] Raw text was: ${reasonText}`);
    writeFileSync(path.join(OUTPUT_DIR, 'run-transcript.md'), '```\n' + transcript.join('\n') + '\n```\n');
    process.exit(1);
  }
  log(`[REASON] Parsed verdict: ${JSON.stringify(verdict, null, 2)}`);

  // ---- ACT + OBSERVE (bounded loop) ----
  const flagNames = verdict.flags.map(f => f.medicine).join(', ') || '(none)';
  let observedOk = false;

  for (let attempt = 1; attempt <= 3 && !observedOk; attempt++) {
    const actMcpServers = { filesystem: FILESYSTEM_MCP };
    let actPrompt = `Write a Markdown validation report to "${REPORT_PATH}" using your filesystem tools, summarizing this verdict:

${JSON.stringify(verdict, null, 2)}

The report must have a top heading, a line stating the overall severity, and one bullet per flag (medicine, type, severity, detail). If there are no flags, state that clearly instead.`;

    if (verdict.overallSeverity === 'high') {
      if (DRY_RUN) {
        actPrompt += `\n\nThe overall severity is HIGH, but this is a DRY RUN — do NOT open a GitHub issue. Just say in your reply that an issue would have been opened, listing which flags would be in it.`;
      } else {
        actMcpServers.github = GITHUB_MCP;
        actPrompt += `\n\nThe overall severity is HIGH. Also open a new GitHub issue in the "${GITHUB_REPO}" repository (using your GitHub tools) titled "Medicine validator: high-severity flag in sample scan" with a body listing the high-severity flags from the verdict above in Markdown.`;
      }
    }

    await runPhase(`ACT (attempt ${attempt})`, actPrompt, {
      mcpServers: actMcpServers,
      disallowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      skills: []
    });

    // ---- OBSERVE ----
    const observeText = await runPhase(
      `OBSERVE (attempt ${attempt})`,
      `Read back the file "${REPORT_PATH}" using your filesystem tools. Confirm it is non-empty, has a heading, and mentions each of these flagged medicines if any: ${flagNames}. Reply with exactly "OBSERVE_OK" if it looks correct, or "OBSERVE_RETRY: <short reason>" if something is missing or wrong.`,
      {
        mcpServers: { filesystem: FILESYSTEM_MCP },
        disallowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        skills: []
      }
    );

    if (/OBSERVE_OK/.test(observeText)) {
      observedOk = true;
      log(`\n[LOOP] Observe confirmed the report on attempt ${attempt}.`);
    } else {
      log(`\n[LOOP] Observe was not satisfied on attempt ${attempt}: ${observeText}`);
    }
  }

  if (!observedOk) {
    log('\n[LOOP] Gave up after 3 attempts without a confirmed report.');
  }

  log(`\n=== TOTALS ===`);
  log(`input_tokens=${totalInputTokens} output_tokens=${totalOutputTokens} total_tokens=${totalInputTokens + totalOutputTokens} cost_usd=$${totalCostUsd.toFixed(4)}`);

  writeFileSync(path.join(OUTPUT_DIR, 'run-transcript.md'), '```\n' + transcript.join('\n') + '\n```\n');
  log(`\nTranscript written to ${path.join(OUTPUT_DIR, 'run-transcript.md')}`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
