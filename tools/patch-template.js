/*
 * Injects (or removes) this extension's block in a CloudPanel Twig template.
 *
 *   node patch-template.js <template> <block-file> <helper-port>
 *   node patch-template.js <template> --remove
 *
 * The block is delimited by Twig comment markers, so the template keeps
 * whatever CloudPanel (or another extension) put in it: we only ever add or
 * drop our own marked region, never rewrite the file. That is what makes this
 * safe to re-run after a CloudPanel update, and safe to combine with other
 * extensions patching the same template.
 */
const fs = require('fs');

const BEGIN = '{# BEGIN cloudpanel-bun-helper #}';
const END = '{# END cloudpanel-bun-helper #}';

const target = process.argv[2];
const blockFile = process.argv[3];
const helperPort = process.argv[4];

if (!target || !blockFile) {
    console.error('Usage: patch-template.js <template> <block-file|--remove> [helper-port]');
    process.exit(1);
}

let text;

try {
    text = fs.readFileSync(target, 'utf8');
} catch (error) {
    console.error(`Cannot read template: ${target}`);
    process.exit(1);
}

// Drop any block we injected before, so installing twice does not stack copies.
const beginIndex = text.indexOf(BEGIN);
const endIndex = text.indexOf(END);

if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    let cut = endIndex + END.length;

    if (text[cut] === '\r') cut++;
    if (text[cut] === '\n') cut++;

    text = text.slice(0, beginIndex) + text.slice(cut);
} else if (beginIndex !== -1 || endIndex !== -1) {
    console.error(`Template has an unbalanced cloudpanel-bun-helper block: ${target}`);
    process.exit(1);
}

if (blockFile === '--remove') {
    fs.writeFileSync(target, text);
    process.exit(0);
}

let block;

try {
    block = fs.readFileSync(blockFile, 'utf8');
} catch (error) {
    console.error(`Cannot read block file: ${blockFile}`);
    process.exit(1);
}

if (helperPort) block = block.replace(/__BUN_HELPER_PORT__/g, helperPort);

if (block.indexOf(BEGIN) === -1 || block.indexOf(END) === -1) {
    console.error(`Block file is missing its markers: ${blockFile}`);
    process.exit(1);
}

// The block goes inside the template's last block (the body one in every
// template we patch), just before it closes, so it renders as page content.
const endblockPattern = /\{%-?\s*endblock\s*-?%\}/g;
let lastEndblock = -1;
let match;

while ((match = endblockPattern.exec(text)) !== null) {
    lastEndblock = match.index;
}

if (lastEndblock === -1) {
    console.error(`Could not find a Twig endblock in: ${target}`);
    process.exit(1);
}

text = text.slice(0, lastEndblock) + block.trimEnd() + '\n' + text.slice(lastEndblock);

fs.writeFileSync(target, text);