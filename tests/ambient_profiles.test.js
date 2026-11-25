'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AmbientProfiles, KEY, modeFromSignal, cleanSnapshot } = require('../apps/g21_ambient/ambient_profiles');

test('legacy profiles retain RGB and brightness and drop individual policies on save', () => {
    const main = { rgb: [100, 101, 102], brightness: 80 };
    const zones = { '0:1': { mode: 'own', rgb: [11, 22, 33], brightness: 55 } };
    const look = { main, zones };
    const stored = { [KEY]: JSON.stringify({ favorites: [null, null, look], modes: { sport: look }, zones, follow: true }) };
    const settings = { get: k => stored[k], set: (k, v) => { stored[k] = v; } };
    const profiles = new AmbientProfiles(settings);
    const expected = { main: { ...main, on: 1 } };
    assert.deepEqual(profiles.loadFavorite(2), expected);
    assert.deepEqual(profiles.mode('sport'), expected);
    assert.equal(profiles.data.follow, true);
    profiles.saveFavorite(1, profiles.snapshot({ rgb: [0, 0, 0], on: 0 }, 75));
    profiles.clearFavorite(2);
    const reloaded = new AmbientProfiles(settings);
    assert.equal(reloaded.loadFavorite(2), null);
    assert.deepEqual(reloaded.loadFavorite(1), { main: { rgb: [0, 0, 0], brightness: 75, on: 0 } });
    assert.deepEqual(reloaded.mode('sport'), expected);
    assert(!JSON.stringify(JSON.parse(stored[KEY])).includes('zones'));
});

test('profiles tolerate invalid storage and reject malformed RGB', () => {
    const profiles = new AmbientProfiles({ get: () => '{{' });
    assert.equal(profiles.loadFavorite(0), null);
    assert.equal(profiles.mode('sport'), null);
    assert.equal(cleanSnapshot({ main: { rgb: [300, 0, 0], brightness: 100 } }), null);
    assert.equal(cleanSnapshot({ main: { rgb: new Array(3) } }), null);
});

test('mode parser reads names and BMW FES numeric enum values', () => {
    const mode = actualValueModeDrivingExperience => modeFromSignal({ actualValueModeDrivingExperience });
    assert.equal(mode('SPORT_EXPERT'), 'sport');
    assert.equal(mode(7), 'eco');
    assert.equal(mode('COMFORT'), 'comfort');
    assert.equal(mode('ADAPTIVE'), 'adaptive');
    assert.equal(mode('UNKNOWN'), null);
    assert.equal(mode(true), null);
});
