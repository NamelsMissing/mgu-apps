'use strict';

// Dedicated firewall rule for GIF Home; never modify Phone Terminal's tag.
const child = require('child_process');
const fs = require('fs');
const TAG = 'mgu-gif-net';
const IFACE = 'wlan_bridge';
const PORT = 18883;
const LOCAL_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];
const CHAIN = ['ip', 'filter', 'input'];

function execNft(args) {
    return new Promise((resolve, reject) => {
        child.execFile('nft', args, {timeout:3000, maxBuffer:4 << 20}, (error, stdout, stderr) => {
            if (error) return reject(new Error('nft: ' + (String(stderr || '').trim() || error.message)));
            resolve(stdout);
        });
    });
}

function makeFirewall(options) {
    options = options || {};
    const run = options.run || execNft;
    const interfacePresent = options.interfacePresent || (() => fs.existsSync('/sys/class/net/' + IFACE));
    const tag = TAG;
    const comment = new RegExp('\\bcomment "' + tag + '"\\s+# handle');

    function rules() {
        return run(['-a', 'list', 'chain'].concat(CHAIN)).then(listing => {
            const rows = String(listing).split('\n').filter(line =>
                /# handle \d+\s*$/.test(line) && !/^\s*(chain|table)\b/.test(line));
            return {rows, tagged:rows.filter(line => comment.test(line))};
        });
    }
    function removeTagged(lines) {
        return lines.reduce((p, line) => p.then(() => {
            const m = /# handle (\d+)\s*$/.exec(line);
            return m ? run(['delete', 'rule'].concat(CHAIN, ['handle', m[1]])) : undefined;
        }), Promise.resolve());
    }
    async function ensure() {
        if (!interfacePresent()) throw new Error('wlan_bridge is not available');
        const current = await rules();
        const existing = current.tagged.length === 1 ? current.tagged[0] : null;
        const index = existing ? current.rows.indexOf(existing) : -1;
        const expected = existing && existing.indexOf('iifname "' + IFACE + '"') >= 0 &&
            existing.indexOf('tcp dport ' + PORT) >= 0 && /\baccept\b/.test(existing) &&
            existing.indexOf('ip saddr {') >= 0 && LOCAL_RANGES.every(range => existing.indexOf(range) >= 0);
        // Phone Terminal's separate ACCEPT may precede us. Do not fight for
        // the first slot (its service also periodically restores its rule).
        const blockingBefore = index > 0 && current.rows.slice(0, index).some(line =>
            /\b(drop|reject|jump|goto)\b/.test(line));
        if (expected && !blockingBefore) return 'kept';
        await removeTagged(current.tagged);
        await run(['insert', 'rule'].concat(CHAIN, [
            'iifname', '"' + IFACE + '"', 'ip', 'saddr', '{ ' + LOCAL_RANGES.join(', ') + ' }', 'tcp', 'dport', String(PORT),
            'accept', 'comment', '"' + TAG + '"'
        ]));
        return 'added';
    }
    async function close() {
        let current;
        try { current = await rules(); }
        catch (e) {
            if (/No such file or directory|does not exist/i.test(e.message)) return;
            throw e;
        }
        await removeTagged(current.tagged);
    }
    return {ensure, close};
}

module.exports = {makeFirewall, TAG, IFACE, PORT};

if (require.main === module && process.argv[2] === 'close') {
    makeFirewall().close().catch(e => {
        console.error('[mgu-gif-net] final firewall cleanup: ' + e.message);
        process.exitCode = 1;
    });
}
