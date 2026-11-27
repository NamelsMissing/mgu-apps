'use strict';

// Dedicated firewall rule for the Active Sound phone link (phone browser ->
// head unit). Its own tag: the rules of Phone Terminal, Video Hub, Custom Cluster and Light Show
// are never touched.
const child = require('child_process');
const TAG = 'mgu-sound-net';
const IFACE = 'wlan_bridge';
const PORT = 18885;
const CHAIN = ['ip', 'filter', 'input'];

function execNft(args) {
    return new Promise((resolve, reject) => {
        child.execFile('nft', args, {timeout:15000, maxBuffer:4 << 20}, (error, stdout, stderr) => {
            if (error) return reject(new Error('nft: ' + (String(stderr || '').trim() || error.message)));
            resolve(stdout);
        });
    });
}

function makeFirewall(options) {
    options = options || {};
    const run = options.run || execNft;
    const tag = TAG;
    const comment = 'comment "' + tag + '"';

    function rules() {
        return run(['-a', 'list', 'chain'].concat(CHAIN)).then(listing => {
            const rows = String(listing).split('\n').filter(line =>
                /# handle \d+\s*$/.test(line) && !/^\s*(chain|table)\b/.test(line));
            return {rows, tagged:rows.filter(line => line.indexOf(comment) >= 0)};
        });
    }
    function removeTagged(lines) {
        return lines.reduce((p, line) => p.then(() => {
            const m = /# handle (\d+)\s*$/.exec(line);
            return m ? run(['delete', 'rule'].concat(CHAIN, ['handle', m[1]])) : undefined;
        }), Promise.resolve());
    }
    async function ensure() {
        const current = await rules();
        const existing = current.tagged.length === 1 ? current.tagged[0] : null;
        const index = existing ? current.rows.indexOf(existing) : -1;
        const expected = existing && existing.indexOf('iifname "' + IFACE + '"') >= 0 &&
            existing.indexOf('tcp dport ' + PORT) >= 0 && /\baccept\b/.test(existing);
        // Other tools' separate ACCEPT rules may precede us. Do not fight for
        // the first slot (its service also periodically restores its rule).
        const blockingBefore = index > 0 && current.rows.slice(0, index).some(line =>
            /\b(drop|reject|jump|goto)\b/.test(line));
        if (expected && !blockingBefore) return 'kept';
        await removeTagged(current.tagged);
        await run(['insert', 'rule'].concat(CHAIN, [
            'iifname', '"' + IFACE + '"', 'tcp', 'dport', String(PORT),
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
        console.error('[mgu-sound-net] final firewall cleanup: ' + e.message);
        process.exitCode = 1;
    });
}
