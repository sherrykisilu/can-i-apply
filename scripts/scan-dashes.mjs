#!/usr/bin/env node
/**
 * Fail the build if any tracked file contains a dash in the U+2012 to U+2015 range.
 *
 * Em dashes and en dashes are banned in this repository. This runs in CI so the rule is enforced
 * rather than remembered.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BANNED = /[\u2012\u2013\u2014\u2015]/g;
const BINARY = /\.(png|jpg|jpeg|gif|ico|pdf|zip|gz|woff2?|ttf|eot)$/i;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file.length > 0 && !BINARY.test(file));

let failures = 0;

for (const file of files) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const lines = contents.split(/\r?\n/);
  lines.forEach((line, index) => {
    BANNED.lastIndex = 0;
    if (BANNED.test(line)) {
      failures += 1;
      console.error(`${file}:${index + 1}: contains a banned dash character`);
      console.error(`  ${line.trim().slice(0, 160)}`);
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} line(s) contain U+2012 to U+2015.`);
  process.exit(1);
}

console.log(`scanned ${files.length} tracked files, no banned dash characters found`);
