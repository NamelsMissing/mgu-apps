'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'native/phone-bridge/public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'native/phone-bridge/public/client.js'), 'utf8');

assert.ok(markup.includes('The session stays active until'), 'UI must describe the persistent session');
assert.ok(script.includes('Access revoked or MGU restarted'), 'UI must detect revocation/restart');
for (const id of ['clear-command', 'copy-output', 'copy-status']) {
    assert.ok(markup.includes('id="' + id + '"'), 'missing button/status id ' + id);
}

function makePage(copyResult) {
    const elements = {};
    const clipboardCalls = [];
    let selectedText = '';
    let selectedOutput = false;
    const fakeElement = () => ({
        value: '', textContent: '', style: {}, readOnly: false,
        classList: { add() {}, toggle() {}, contains() { return true; } },
        addEventListener(type, callback) { this.handlers = this.handlers || {}; this.handlers[type] = callback; },
        focus() {}, select() { selectedText = this.value; }, setSelectionRange() {},
        getAttribute() { return ''; }
    });
    const document = {
        getElementById(id) { return elements[id] || (elements[id] = fakeElement()); },
        querySelectorAll() { return []; },
        createElement() { return fakeElement(); },
        createRange() { return { selectNodeContents(node) { selectedOutput = node === elements.output; } }; },
        execCommand(command) {
            assert.strictEqual(command, 'copy');
            clipboardCalls.push(selectedText);
            return copyResult;
        },
        body: { appendChild() {}, removeChild() {} }
    };
    const window = {
        location: { hash: '' },
        getSelection() { return { removeAllRanges() {}, addRange() {} }; }
    };
    vm.runInNewContext(script, {
        document, window, navigator: {},
        location: { pathname: '/' }, history: { replaceState() {} },
        fetch: async () => ({ ok: false }), setInterval() {}, confirm() { return true; }
    }, { filename: 'client.js' });
    document.getElementById('output');
    return {
        elements, clipboardCalls,
        click(id) { elements[id].handlers.click(); },
        get selectedOutput() { return selectedOutput; }
    };
}

const page = makePage(true);
const completeOutput = 'root@mgu # find /usr/lib\nfirst file\nsecond file\n[exit 0, 660ms]';
page.elements.command.value = 'find /usr/lib';
page.elements.output.textContent = completeOutput;
page.elements.output.scrollTop = 9999;
page.click('clear-command');
assert.strictEqual(page.elements.command.value, '', 'clear command resets input');
assert.strictEqual(page.elements.output.textContent, completeOutput, 'clear command does not erase output');
page.click('copy-output');
assert.deepStrictEqual(page.clipboardCalls, [completeOutput], 'copy includes the entire accumulated output');
assert.strictEqual(page.elements['copy-status'].textContent, 'Complete output copied to clipboard.');

const blockedPage = makePage(false);
blockedPage.elements.output.textContent = completeOutput;
blockedPage.click('copy-output');
assert.strictEqual(blockedPage.selectedOutput, true, 'blocked clipboard selects the output manually');
assert.ok(/Automatic copy blocked/.test(blockedPage.elements['copy-status'].textContent));

console.log('Phone Terminal UI: clear command and full output clipboard fallback');
