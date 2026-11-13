'use strict';
const C = require('./controls');
const G = require('./kit/gauges');

const WHITE = '#eef3fc', DIM = '#909eaf', AMBER = '#ffbd69';
function fit(r, text, width, size) {
    let s = String(text).replace(/ß/g, 'ss'); if (r.textWidth(s, size) <= width) return s;
    while (s.length && r.textWidth(s + '…', size) > width) s = s.slice(0, -1);
    return s + '…';
}
function draw(r, t, s, a) {
    const BLUE = t.accent2 || '#7bc6ff';
    r.clear('#050910');
    const targets = [], focusTargets = [], B = s.store.state.bindings;
    const target = (key, x, y, w, h, act, focus) => {
        const q = { key, x, y, w, h, act, run: () => { if (!s.busy) return act(x + w / 2, y + h / 2); } };
        targets.push(q); if (focus !== false) focusTargets.push(q);
    };
    const text = (v, x, y, size, color, options) => r.text(String(v).replace(/ß/g, 'ss'), x, y, size || 25, color || WHITE, options);
    function button(key, x, y, w, label, fn, on) {
        r.roundRect(x, y, w, 52, 12, on ? '#25527a' : '#192330');
        r.strokeRoundRect(x, y, w, 52, 12, 1, on ? BLUE : '#334053');
        text(fit(r, label, w - 28, 22), x + w / 2, y + 34, 22, WHITE, { align: 'center' });
        target(key, x, y, w, 52, fn);
    }
    function panel(x, y, w, h) { r.roundRect(x, y, w, h, 18, '#0e1724'); r.strokeRoundRect(x, y, w, h, 18, 1, '#202d3f'); }
    const raw = (id) => id in s.draft ? s.draft[id] : s.current[id];
    const ready = (id) => C.validBinding(B[id]) && C.normalized(B[id], s.current[id]) !== null;
    const value = (id) => ready(id) ? C.percent(B[id], raw(id)) : '--';
    const selected = s.page === 1 ? C.CONTROLS.filter((c) => c.group === 'tone')[s.selected.tone] : C.CONTROLS[s.selected.eq];
    if (s.page === 0) {
        const config = s.dspDraft || s.dspConfig, chosen = config.bands[s.selected.eq];
        const hz = (v) => v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + ' kHz' : v + ' Hz';
        const db = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
        text('7-BAND PCM-DSP', 44, 89, 23, DIM, { spacing: 2 });
        C.CONTROLS.filter((c) => c.group === 'eq').forEach((c, i) => {
            const x = 42 + i * 157, w = 138, sel = i === s.selected.eq, b = config.bands[i];
            panel(x, 114, w, 326);
            if (sel) r.strokeRoundRect(x, 114, w, 326, 18, 2, BLUE);
            text(hz(b.frequencyHz), x + w / 2, 151, 23, WHITE, { align: 'center' });
            text(db(b.gainDb), x + w / 2, 191, 26, s.dspDraft ? AMBER : BLUE, { align: 'center', font: 'num' });
            const cy = 300, span = 82, n = b.gainDb / 12;
            r.line(x + w / 2, cy - span, x + w / 2, cy + span, 6, '#263245');
            for (const u of [-1, -0.5, 0, 0.5, 1]) r.line(x + 40, cy - u * span, x + w - 40, cy - u * span, u === 0 ? 2 : 1, '#38465a');
            r.line(x + w / 2, cy, x + w / 2, cy - n * span, 6, BLUE);
            r.roundRect(x + 45, cy - n * span - 10, w - 90, 20, 7, '#d4ebff');
            target(c.id + '-track', x + 15, 207, w - 30, 190, (px, py) => { a.select(c.id); a.gain(i, C.clamp((cy - py) / span, -1, 1) * 12); }, false);
            text('Q ' + b.q.toFixed(1), x + w / 2, 417, 19, DIM, { align: 'center' });
            target(c.id, x, 114, w, 88, () => a.select(c.id));
        });
        panel(1160, 114, 398, 326);
        // Highlight the *committed* state, not an unsaved EQ draft.
        button('dsp-on', 1184, 130, 168, 'DSP EIN', a.dspOn, !!s.dspConfig.enabled);
        button('dsp-bypass', 1363, 130, 169, 'BYPASS EIN', a.dspBypass, !s.dspConfig.enabled);
        const paramNames = ['Gain', 'Frequenz', 'Q / Bandbreite', 'Vorverstärkung'];
        const paramValue = [db(chosen.gainDb), hz(chosen.frequencyHz), chosen.q.toFixed(1), db(config.preampDb)][s.dspParameter];
        button('dsp-param', 1184, 194, 348, paramNames[s.dspParameter] + ': ' + paramValue, a.parameter);
        button('minus', 1184, 258, 103, '−', () => a.adjust(-1));
        button('plus', 1300, 258, 103, '+', () => a.adjust(1));
        button('center', 1416, 258, 116, '0 dB', a.neutral);
        button('apply', 1184, 322, 348, 'DSP übernehmen', a.apply, true);
        const effective = config.preampDb - (config.autoHeadroom ? config.bands.reduce((n, b) => n + Math.max(0, b.gainDb), 0) : 0);
        const play = s.testMusic && s.testMusic.playing;
        button('test-music', 1184, 382, 168, play ? 'Stop' : 'Testmusik', a.testMusic, play);
        button('dsp-headroom', 1363, 382, 169, config.autoHeadroom ? 'Headroom auto' : 'Headroom aus', a.headroom);
        button('music-wav-export', 44, 454, 398, 'Night Drive WAV Export', a.exportWave);
        text('Vergleich: 2 WAV-Dateien fuer USB / kein Live-CarPlay-EQ', 465, 488, 18, DIM);
        text('HR ' + db(effective) + ' · ' + (s.testMusic ? s.testMusic.status : 'idle') + ' · ' + (s.dspConfig.enabled ? 'DSP aktiv' : 'Bypass aktiv'), 1184, 466, 17, DIM);
    } else if (s.page === 1) {
        text('BASS, HÖHEN UND VERTEILUNG', 44, 90, 23, DIM, { spacing: 2 });
        C.CONTROLS.filter((c) => c.group === 'tone').forEach((c, i) => {
            const x = 44 + (i % 2) * 772, y = 117 + Math.floor(i / 2) * 163, w = 740, active = ready(c.id), sel = i === s.selected.tone;
            panel(x, y, w, 144);
            if (sel) r.strokeRoundRect(x, y, w, 144, 18, 2, BLUE);
            text(c.label, x + 26, y + 41, 28);
            text(active ? value(c.id) : 'Einrichten', x + w - 25, y + 41, 24, c.id in s.draft ? AMBER : active ? BLUE : DIM, { align: 'right' });
            const left = x + 52, right = x + w - 52, center = (left + right) / 2, n = active ? C.normalized(B[c.id], raw(c.id)) : 0;
            r.line(left, y + 90, right, y + 90, 5, '#29364a'); r.line(center, y + 76, center, y + 104, 2, '#4b5d73');
            if (active) { r.line(center, y + 90, center + n * (right - left) / 2, y + 90, 5, BLUE); r.circle(center + n * (right - left) / 2, y + 90, 12, '#d4ebff'); }
            text(c.id === 'balance' ? 'Links' : '−', left, y + 126, 17, DIM);
            text(c.id === 'balance' ? 'Rechts' : '+', right, y + 126, 17, DIM, { align: 'right' });
            target(c.id, x, y, w, 56, () => a.select(c.id));
            target(c.id + '-track', x, y + 56, w, 88, active ? (px) => { a.select(c.id); a.set(c.id, C.clamp((px - center) / ((right - left) / 2), -1, 1)); } : () => a.select(c.id), false);
        });
        button('tone-reset', 44, 435, 220, 'Auswahl auf Mitte', a.neutral);
        button('tone-minus', 280, 435, 116, '−', () => a.adjust(-1));
        button('tone-plus', 412, 435, 116, '+', () => a.adjust(1));
        button('tone-apply', 1240, 435, 316, 'Übernehmen', a.apply, true);
    } else if (s.page === 2) {
        text('SCHNELL ZU DEINEM SOUND', 44, 89, 23, DIM, { spacing: 2 });
        s.profiles.forEach((p, i) => {
            const x = 44 + (i % 3) * 513, y = 119 + Math.floor(i / 3) * 141, on = i === s.selected.profile, saved = s.store.state.dspProfiles[p[0]], old = s.store.state.profiles[p[0]];
            panel(x, y, 487, 120); if (on) r.strokeRoundRect(x, y, 487, 120, 18, 2, BLUE);
            text(p[1], x + 27, y + 44, 28, on ? BLUE : WHITE);
            text(i < 3 ? ['DSP-Bänder auf 0 dB', 'Tiefe Frequenzen anheben', 'Mitten und Sprachverständlichkeit'][i] : saved ? '7 DSP-Bänder gespeichert' : old ? 'Bisheriges BMW-Profil vorhanden' : 'Freier Speicherplatz', x + 27, y + 84, 20, DIM);
            target('profile-' + i, x, y, 487, 120, () => a.profile(i));
        });
        button('load', 44, 415, 300, 'Vorschau laden', a.load);
        button('save', 366, 415, 300, 'Auswahl speichern', a.save);
        button('discard', 688, 415, 300, 'Entwurf verwerfen', a.discard);
        button('profile-apply', 1115, 415, 442, 'Vorbereiteten Klang übernehmen', a.apply, true);
    } else if (s.page === 3) {
        const l = s.store.state.learning, c = l ? C.CONTROLS.find((p) => p.id === l.control) : C.CONTROLS[s.selected.setup], phase = l ? l.shots.length : -1;
        panel(44, 92, 414, 358); panel(482, 92, 1075, 358);
        text('REGLER ZUORDNEN', 72, 136, 22, DIM, { spacing: 1 });
        text(c.label, 72, 206, 44);
        text(B[c.id] ? 'Bereits eingerichtet' : 'Noch nicht eingerichtet', 72, 251, 23, B[c.id] ? BLUE : DIM);
        text('Nur vorhandene BMW-Regler', 72, 305, 20, DIM);
        text('lassen sich zuordnen.', 72, 335, 20, DIM);
        button('learn-next', 72, 370, 358, 'Nächsten Regler wählen', a.next);
        text(phase < 0 ? 'Einmalig im BMW-Klangmenü einrichten' : ['1 · Ausgangsmitte erfassen', '2 · Minimum erfassen', '3 · Maximum erfassen', '4 · Rückkehr zur Mitte bestätigen'][phase], 516, 140, 31);
        const lines = phase < 0 ? ['Wähle den Regler, den dein BMW-Klangmenü anbietet.', 'Die App vergleicht Mitte, Minimum, Maximum und wieder Mitte.', 'Während der Messungen wird nur gelesen.']
            : [['Öffne das BMW-Klangmenü und stelle ' + c.label + ' auf Mitte.', 'Kehre dann in diese App zurück und erfasse die Messung.', 'Alle anderen Klangregler während der Einrichtung unverändert lassen.'],
               ['Stelle im BMW-Klangmenü nur ' + c.label + ' ganz nach links.', 'Das ist das Minimum dieses Reglers.', 'Danach zurückkehren und Messung erfassen.'],
               ['Stelle im BMW-Klangmenü nur ' + c.label + ' ganz nach rechts.', 'Das ist das Maximum dieses Reglers.', 'Danach zurückkehren und Messung erfassen.'],
               ['Stelle ' + c.label + ' wieder genau auf die ursprüngliche Mitte.', 'Erfasse die letzte Messung. Die Zuordnung wird geprüft.', 'Danach kann der Regler in dieser App verwendet werden.']][phase];
        lines.forEach((v, i) => text(fit(r, v, 1005, 24), 516, 201 + i * 41, 24, DIM));
        for (let i = 0; i < 4; i++) { r.circle(535 + i * 64, 354, 17, phase > i ? BLUE : phase === i ? '#3d6894' : '#263345'); text(i + 1, 535 + i * 64, 361, 19, WHITE, { align: 'center' }); }
        button('capture', 830, 328, 374, l ? 'Messung erfassen' : 'Einrichten starten', a.capture, true);
        if (l) button('cancel', 1225, 328, 294, 'Abbrechen', a.cancel);
        text('Diese Einrichtung betrifft BMW-Regler. Die eigenen DSP-Bänder im DSP-Tab benötigen sie nicht.', 44, 483, 22, DIM);
    } else {
        const shot = s.snapshot || { points: [], scopes: [], errors: [] };
        panel(44, 92, 760, 310); panel(828, 92, 730, 310);
        text('VERBINDUNG & WERTE', 73, 136, 23, DIM, { spacing: 1 });
        [['DSP-Dienst', s.dspOnline ? 'Verbunden · ' + (s.dspStatus.streams || []).length + ' PCM-Quellen' : 'Nicht verbunden'],
         ['PCM-Frames gesamt', s.dspStatus ? s.dspStatus.frames : '--'], ['BMW-Klangwerte', shot.points.length],
         ['CarPlay / Radio', 'Noch nicht an DSP angebunden'], ['Version', '0.2.4 · WAV-Vergleich experimentell']].forEach((v, i) => {
            text(v[0], 73, 187 + i * 42, 23, DIM); text(v[1], 774, 187 + i * 42, 22, WHITE, { align: 'right' });
        });
        text('LETZTE MELDUNGEN', 856, 136, 23, DIM, { spacing: 1 });
        const errors = (s.diagnostics ? [s.diagnostics] : []).concat(shot.errors, s.audio.errors).slice(0, 5);
        (errors.length ? errors : ['Keine Fehler gemeldet', 'Rücklesen bestätigt den Zahlenwert.', 'Die hörbare Wirkung wird im Fahrzeug geprüft.']).forEach((v, i) => text(fit(r, v, 672, 21), 856, 185 + i * 40, 21, errors.length ? AMBER : DIM));
        button('export', 44, 425, 365, 'Diagnose exportieren', a.export);
        button('discard', 432, 425, 365, 'Entwurf verwerfen', a.discard);
        text('Export: equalizer-diagnostics.json im App-Datenordner', 828, 459, 21, DIM);
    }
    if (s.page === 0) text('Quelle: verbundene PCM-Apps, z. B. Video Hub · CarPlay und Radio noch nicht angebunden', 44, 480, 21, DIM);
    r.fillRect(0, 499, 1600, 21, '#0a111c');
    text(fit(r, (s.busy ? '● ' : '') + s.status, 1490, 17), 44, 516, 17, s.busy ? AMBER : DIM);
    // Native HMI bar remains available without touch routing or the GPU renderer.
    s.targets = targets; r.targets = focusTargets;
    const live = s.dspOnline && s.dspStatus.streams.some((x) => x.frames > 0 && x.lastFrameAt && Date.now() - x.lastFrameAt < 3000);
    const badge = s.page === 0 ? !s.dspOnline ? 'DSP OFFLINE' : live && s.dspConfig.enabled ? 'DSP LIVE' : s.dspConfig.enabled ? 'DSP BEREIT' : 'BYPASS' : s.connected ? 'BMW AUDIO' : 'BMW OFFLINE';
    G.frame(r, t, s.tabs, s.page, [{ text: s.busy ? 'ARBEITET' : badge, color: s.dspOnline || s.connected ? BLUE : DIM }]);
}
module.exports = { draw };
