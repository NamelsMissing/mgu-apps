'use strict';

(function () {
    const $ = (id) => document.getElementById(id);
    const state = $('state'), pairPanel = $('pair-panel'), terminal = $('terminal-panel');
    let busy = false, preparingFile = false;

    function showAuth(active) {
        pairPanel.classList.toggle('hidden', active);
        terminal.classList.toggle('hidden', !active);
        state.textContent = active ? 'Connected' : 'Not connected';
        state.classList.toggle('ok', active);
        $('expiry').textContent = active ? 'Active until Disconnect, Revoke Access or MGU restart.' : '';
        if (!active) $('save-file').classList.add('hidden');
    }
    async function api(endpoint, body) {
        const res = await fetch('/api/' + endpoint, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': '1' },
            body: JSON.stringify(body || {})
        });
        let json;
        try { json = await res.json(); } catch (e) { throw new Error('Invalid bridge response'); }
        if (!res.ok) throw new Error(json.error || 'Request failed');
        return json;
    }
    async function startup() {
        const match = /^#pair=([0-9a-f]{64})$/.exec(window.location.hash);
        // The one-time code is in the fragment, never in the HTTP request URL or referrer.
        if (match) {
            history.replaceState(null, '', location.pathname);
            try {
                const result = await api('pair', { token: match[1] });
                showAuth(true);
                return;
            } catch (e) { $('pair-message').textContent = e.message + '. Start a new session on the car.'; }
        }
        try {
            const res = await fetch('/api/status', { cache: 'no-store' });
            if (!res.ok) throw new Error('Not connected');
            const data = await res.json();
            showAuth(true);
        } catch (e) { showAuth(false); }
    }
    function dangerous(cmd) {
        return /\b(?:rm|dd|mkfs|fdisk|parted|mount|umount|chmod|chown|systemctl|reboot|shutdown|halt|poweroff|flash|killall|pkill)\b|\s[>]|\s*&&\s*|\s*;\s*/i.test(cmd);
    }
    async function run() {
        if (busy) return;
        const cmd = $('command').value.trim();
        if (!cmd) return;
        if (dangerous(cmd) && !confirm('This command may change or damage the head unit. Execute as root?')) return;
        busy = true;
        $('run').disabled = true;
        $('hint').textContent = 'Executing…';
        $('output').textContent += '\n\nroot@mgu # ' + cmd + '\n';
        try {
            const result = await api('exec', { command: cmd });
            $('output').textContent += (result.stdout || '') + (result.stderr ? '\n[stderr]\n' + result.stderr : '');
            if (result.truncated) $('output').textContent += '\n[output limit reached]';
            if (result.timedOut) $('output').textContent += '\n[15-second command timeout]';
            $('output').textContent += '\n[exit ' + result.code + ', ' + result.elapsedMs + 'ms]';
        } catch (e) {
            $('output').textContent += '\n[error] ' + e.message;
            if (/Session ended|Not paired/.test(e.message)) showAuth(false);
        } finally {
            busy = false; $('run').disabled = false;
            $('hint').textContent = 'Commands execute as root.';
            $('output').scrollTop = $('output').scrollHeight;
        }
    }
    $('run').addEventListener('click', run);
    $('command').addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); run(); }
    });
    document.querySelectorAll('[data-cmd]').forEach((button) => {
        button.addEventListener('click', () => { $('command').value = button.getAttribute('data-cmd'); });
    });
    $('clear-command').addEventListener('click', () => { $('command').value = ''; });
    // The MGU uses local HTTP. On iOS, navigator.clipboard may be unavailable
    // in that insecure context, so first try a synchronous user-gesture copy.
    function copyWithSelection(text) {
        const field = document.createElement('textarea');
        field.value = text;
        field.readOnly = true;
        field.style.position = 'fixed';
        field.style.top = '0';
        field.style.left = '0';
        field.style.opacity = '0';
        field.style.fontSize = '16px';
        document.body.appendChild(field);
        let copied = false;
        try {
            field.focus();
            field.select();
            field.setSelectionRange(0, text.length);
            copied = document.execCommand('copy');
        } catch (e) { /* Clipboard access may be blocked by the browser. */ }
        document.body.removeChild(field);
        return copied;
    }
    function manualOutputSelection() {
        const selection = window.getSelection && window.getSelection();
        if (selection && document.createRange) {
            const range = document.createRange();
            range.selectNodeContents($('output'));
            selection.removeAllRanges();
            selection.addRange(range);
        }
        $('copy-status').textContent = 'Automatic copy blocked. Output selected — use Copy in the browser.';
    }
    $('copy-output').addEventListener('click', () => {
        const outputText = $('output').textContent;
        if (!outputText) {
            $('copy-status').textContent = 'There is no output to copy.';
            return;
        }
        if (copyWithSelection(outputText)) {
            $('copy-status').textContent = 'Complete output copied to clipboard.';
        } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(outputText).then(() => {
                $('copy-status').textContent = 'Complete output copied to clipboard.';
            }, manualOutputSelection);
        } else {
            manualOutputSelection();
        }
    });
    $('clear').addEventListener('click', () => { $('output').textContent = 'Output cleared.'; });
    $('example-file').addEventListener('click', () => { $('file-path').value = '/tmp/carplay-audio-analysis.tgz'; });
    $('prepare-file').addEventListener('click', async () => {
        if (preparingFile) return;
        const file = $('file-path').value.trim();
        if (!file) { $('file-message').textContent = 'Enter the absolute path of the file.'; return; }
        preparingFile = true;
        $('prepare-file').disabled = true;
        $('save-file').classList.add('hidden');
        $('file-message').textContent = 'Checking the file on the head unit…';
        try {
            const result = await api('download', { path: file });
            const size = result.size < 1024 ? result.size + ' bytes' : (result.size / (1024 * 1024)).toFixed(2) + ' MiB';
            $('save-file').href = result.url;
            $('save-file').download = result.filename;
            $('save-file').textContent = 'Save ' + result.filename;
            $('save-file').classList.remove('hidden');
            $('file-message').textContent = 'File ready (' + size + '). Tap Save within ' + result.validSeconds + ' seconds.';
        } catch (error) {
            $('file-message').textContent = 'Download error: ' + error.message;
            if (/Session ended|Not paired/.test(error.message)) showAuth(false);
        } finally {
            preparingFile = false;
            $('prepare-file').disabled = false;
        }
    });
    $('save-file').addEventListener('click', () => {
        $('file-message').textContent = 'Download requested. Check your browser downloads or Files app. Prepare a new link to retry.';
        $('save-file').classList.add('hidden');
    });
    $('disconnect').addEventListener('click', async () => {
        try {
            await api('logout');
            showAuth(false);
            $('pair-message').textContent = 'Disconnected. Start a new session on the car.';
        } catch (e) {
            $('copy-status').textContent = 'Could not revoke access: ' + e.message + '. Use Revoke Access on iDrive.';
        }
    });
    // Detect server restart or iDrive revocation without imposing a timeout.
    // Ignore transient Wi-Fi dropouts instead of falsely claiming revocation.
    setInterval(async () => {
        if (terminal.classList.contains('hidden')) return;
        try {
            const res = await fetch('/api/status', { cache: 'no-store', credentials: 'same-origin' });
            if (res.status === 401) {
                showAuth(false);
                $('pair-message').textContent = 'Access revoked or MGU restarted. Start a new session in the car.';
            }
        } catch (e) { /* network temporarily unavailable; revoke on iDrive if needed */ }
    }, 10000);
    startup();
})();
