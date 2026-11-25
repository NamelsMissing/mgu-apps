'use strict';

const FILTERS = [
    { key: 'position', label: 'Position', options: [['all', 'All'], ['front', 'Front'], ['side', 'Side'], ['rear', 'Rear']] },
    { key: 'availability', label: 'Availability', options: [['all', 'All'], ['controllable', 'Controllable'], ['unavailable', 'Unavailable']] },
    { key: 'status', label: 'Test status', options: [['all', 'All'], ['visible', 'Visible'], ['untested', 'Not tested'],
        ['not-visible', 'No visible effect'], ['noise', 'Noise']] },
];
const ALL = Object.freeze({ position: 'all', availability: 'all', status: 'all' });

class ListScroll {
    constructor(box) {
        this.box = box;
        this.count = 0;
        this.offset = 0;
    }
    get contentHeight() {
        const rows = Math.ceil(this.count / this.box.columns);
        return rows ? rows * (this.box.rowHeight + this.box.rowGap) - this.box.rowGap : 0;
    }
    get max() { return Math.max(0, this.contentHeight - this.box.h); }
    resize(count) { this.count = count; this.set(this.offset); }
    set(offset) {
        const next = Math.max(0, Math.min(this.max, offset));
        if (next === this.offset) return false;
        this.offset = next;
        return true;
    }
    move(dy) { return this.set(this.offset + dy); }
    reveal(index) {
        if (index < 0 || index >= this.count) return false;
        const b = this.box, top = Math.floor(index / b.columns) * (b.rowHeight + b.rowGap);
        return this.set(Math.max(top + b.rowHeight - b.h, Math.min(this.offset, top)));
    }
    visible() {
        const b = this.box, stride = b.rowHeight + b.rowGap;
        const first = Math.floor((this.offset + b.rowGap) / stride) * b.columns;
        const end = Math.min(this.count, Math.ceil((this.offset + b.h) / stride) * b.columns);
        return { first, end };
    }
}

class LightList {
    constructor(box) {
        this.scroll = new ListScroll(box);
        this.filters = Object.assign({}, ALL, { availability: 'controllable' });
        this.catalog = [];
        this.items = [];
        this.keys = [];
        this.selected = null;
    }
    sync(catalog) {
        if (catalog === this.catalog) return;
        this.catalog = catalog;
        this.refresh();
    }
    filter(key, value) {
        if (value === this.filters[key]) return false;
        this.filters[key] = value;
        this.refresh();
        this.scroll.set(0);
        return true;
    }
    resetFilters() {
        this.filters = Object.assign({}, ALL);
        this.refresh();
        this.scroll.set(0);
    }
    refresh() {
        const f = this.filters;
        const selectedId = this.selected && this.selected.id;
        this.items = this.catalog.filter((lamp) => (f.position === 'all' || lamp.group === f.position)
            && (f.availability === 'all' || lamp.available === (f.availability === 'controllable'))
            && (f.status === 'all' || lamp.status === f.status));
        this.keys = this.items.map((lamp) => lamp.id);
        this.selected = this.items.find((lamp) => lamp.id === selectedId) || this.items[0] || null;
        this.scroll.resize(this.items.length);
    }
    pick(id) {
        const lamp = this.items.find((entry) => entry.id === id);
        if (!lamp || lamp === this.selected) return false;
        this.selected = lamp;
        return true;
    }
}

module.exports = { FILTERS, ListScroll, LightList };
