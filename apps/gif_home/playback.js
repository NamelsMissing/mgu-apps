'use strict';

class Playback {
    constructor(load, report, fallback, random) {
        this.load = load;
        this.report = report;
        this.fallback = fallback;
        this.random = random || Math.random;
        this.id = null;
        this.gif = null;
        this.bag = [];
        this.failed = new Set();
        this.key = '';
        this.start = 0;
        this.pauseAt = null;
    }

    update(state, all, now, speed, skip, resume) {
        const p = state.playback;
        const group = state.groups.find(g => g.id === p.group);
        const ids = p.mode === 'single' ? [p.single] : p.mode === 'all' ? all :
            p.mode === 'group' ? (group ? group.ids : []) : p.selected;
        const key = JSON.stringify([p.mode, p.group, ids]);
        const changed = key !== this.key;
        if (changed) {
            this.key = key;
            this.bag = [];
            this.failed.clear();
        }
        if (p.paused && this.pauseAt === null) this.pauseAt = now;
        if (!p.paused && this.pauseAt !== null) {
            this.start += now - this.pauseAt;
            this.pauseAt = null;
        }
        const clock = p.paused ? this.pauseAt : now;
        const elapsed = Math.max(0, clock - this.start);
        const timed = this.gif && p.mode !== 'single' && !p.paused &&
            elapsed >= (p.seconds ? p.seconds * 1000 : this.gif.duration / speed);
        const choices = ids.filter(id => !this.failed.has(id));
        if (!this.gif || changed || skip || timed) {
            const previous = this.id;
            const random = p.mode !== 'sequential' && p.mode !== 'single';
            if (resume && choices.includes(resume)) this.set(resume, clock);
            if (!this.gif || skip || timed || !choices.includes(this.id)) {
                let remaining = choices.slice();
                while (remaining.length) {
                    let id;
                    if (random) {
                        this.bag = this.bag.filter(item => remaining.includes(item));
                        if (!this.bag.length) {
                            this.shuffle(remaining);
                        }
                        const i = this.bag.findIndex(item => item !== previous);
                        id = this.bag.splice(i < 0 ? 0 : i, 1)[0];
                    } else id = remaining[(remaining.indexOf(previous) + 1) % remaining.length];
                    if (this.set(id, clock)) break;
                    remaining = remaining.filter(item => item !== id);
                }
                if ((!this.gif || !remaining.length) && this.id !== this.fallback) {
                    if (!this.set(this.fallback, clock) && !all.includes(this.id)) {
                        this.id = null;
                        this.gif = null;
                    }
                }
                if (!remaining.length || previous === this.id) this.start = clock;
            }
            // A retained or restored GIF counts as played in this cycle.
            if (changed && random && choices.includes(this.id) && !skip && !timed &&
                (resume === this.id || previous === this.id)) {
                this.shuffle(choices.filter(id => id !== this.id));
            }
        }
        if (!this.gif) return -1;
        let t = Math.max(0, (clock - this.start) * speed) % this.gif.duration;
        for (let i = 0; i < this.gif.frames.length; i++) {
            if (t < this.gif.frames[i].delay) return i;
            t -= this.gif.frames[i].delay;
        }
        return 0;
    }

    shuffle(ids) {
        this.bag = ids.slice();
        for (let i = this.bag.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            const item = this.bag[j];
            this.bag[j] = this.bag[i];
            this.bag[i] = item;
        }
    }

    set(id, clock) {
        if (id === this.id && this.gif) return true;
        if (this.failed.has(id)) return false;
        try {
            const gif = this.load(id);
            this.gif = gif;
            this.id = id;
            this.start = clock;
            this.report('Playback: ' + id);
            return true;
        } catch (_) {
            this.failed.add(id);
            this.report('Decoder could not open GIF: ' + id);
            return false;
        }
    }
}

module.exports = { Playback };
