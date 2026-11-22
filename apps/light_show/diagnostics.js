'use strict';

function report(status, trace) {
    const last = status.lastStop;
    const lines = [
        'Light Show diagnostic report',
        'State: ' + (status.state === 'IDLE' ? 'READY' : status.state),
        status.note,
        last ? 'Last STOP ' + last.at + ': ' + (last.ok ? last.message || 'Release confirmed' : last.error) : 'No STOP result yet',
    ];
    for (const row of trace || []) {
        const address = row.address == null ? '' : '0x' + row.address.toString(16).toUpperCase();
        const ecu = { '0x40': 'BDC', '0x43': 'FLM left', '0x44': 'FLM right', '0x10': 'Gateway', '0xDF': 'Functional scan' }[address]
            || (address ? 'ECU' : '');
        lines.push([row.at, ecu, address, row.step, row.tx && 'TX ' + row.tx, row.rx && 'RX ' + row.rx,
            row.ms != null && row.ms + ' ms', row.error, row.outcome].filter(Boolean).join(' | '));
    }
    return lines.join('\n');
}

module.exports = report;
