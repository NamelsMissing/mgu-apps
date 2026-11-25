/*
 * Snapshot bridge test with fake ALSA (offline only).
 * Usage: test_cp_bridge WORKDIR [stress-iterations]
 */
#define _GNU_SOURCE
#include "carplay_live_filter.h"
#include "eq_snapshot.h"
#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct _snd_pcm snd_pcm_t;
typedef struct _snd_pcm_hw_params {int format; unsigned channels, rate; int access;} snd_pcm_hw_params_t;
int snd_pcm_open(snd_pcm_t **, const char *, int, int);
int snd_pcm_hw_params(snd_pcm_t *, snd_pcm_hw_params_t *);
long snd_pcm_writei(snd_pcm_t *, const void *, unsigned long);
int snd_pcm_close(snd_pcm_t *);
double fake_alsa_rms(void);

#define FRAMES 4096
#define TARGET "smartx:CarPlayMain_CF_48_STEREO"
static int16_t audio[FRAMES * 2];
static char snap_path[512];
static snd_pcm_hw_params_t okay = {2, 2, 48000, 3};

static void signal100(void) {
    for (int i = 0; i < FRAMES; i++) {
        const int16_t v = (int16_t)lround(0.085 * 32767 * sin(2 * 3.141592653589793 * 100 * i / 48000.0));
        audio[i * 2] = v; audio[i * 2 + 1] = v;
    }
}
static void write_snapshot(const char *path, int enabled, double gain0, uint32_t revision) {
    MguEqConfig c; mgu_eq_defaults(&c);
    c.enabled = enabled; c.auto_headroom = 0; c.bands[0].gain_db = gain0;
    unsigned char buf[MGU_EQ_SNAPSHOT_SIZE];
    assert(mgu_eq_snapshot_encode(&c, revision, buf) == MGU_EQ_SNAP_OK);
    char tmp[600];
    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    assert(f && fwrite(buf, 1, sizeof buf, f) == sizeof buf);
    fclose(f);
    assert(rename(tmp, path) == 0); /* same atomic replace as snapshot.js */
}
static void corrupt_snapshot(const char *path) {
    FILE *f = fopen(path, "r+b");
    assert(f && fseek(f, 40, SEEK_SET) == 0);
    fputc(0x7F, f);
    fclose(f);
}
static double play(snd_pcm_t *pcm) { assert(snd_pcm_writei(pcm, audio, FRAMES) == FRAMES); return fake_alsa_rms(); }
static MguCarplayLiveStats stats(void) { MguCarplayLiveStats s; mgu_cp_live_snapshot(&s); return s; }

/* ---- stress: producer rewrites/polls while the "audio thread" writes ---- */
static atomic_int stop_producer;
static pthread_mutex_t producer_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t producer_ready = PTHREAD_COND_INITIALIZER;
static int producer_has_polled;
static void *producer(void *arg) {
    (void)arg;
    uint32_t rev = 100;
    while (!atomic_load(&stop_producer)) {
        switch (rev % 4) {
            case 0: write_snapshot(snap_path, 1, 6, rev); break;
            case 1: write_snapshot(snap_path, 1, -6, rev); break;
            case 2: write_snapshot(snap_path, 0, 0, rev); break;
            default: corrupt_snapshot(snap_path); break;
        }
        (void)mgu_cp_live_bridge_poll(snap_path);
        if (++rev == 105) {
            pthread_mutex_lock(&producer_lock);
            producer_has_polled = 1;
            pthread_cond_signal(&producer_ready);
            pthread_mutex_unlock(&producer_lock);
        }
    }
    return NULL;
}

int main(int argc, char **argv) {
    assert(argc >= 2);
    const int stress = argc > 2 ? atoi(argv[2]) : 2000;
    snprintf(snap_path, sizeof snap_path, "%s/carplay.snapshot", argv[1]);
    unlink(snap_path);
    signal100();
    snd_pcm_t *target = 0, *other = 0;
    assert(snd_pcm_open(&other, "smartx:CarPlayAlternate_CF_24_MONO", 0, 0) == 0);
    assert(snd_pcm_hw_params(other, &okay) == 0);
    const double baseline = play(other);
    assert(snd_pcm_open(&target, TARGET, 0, 0) == 0);
    assert(snd_pcm_hw_params(target, &okay) == 0);

    /* 1. No snapshot file: bridge stays fail-safe bypass. */
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_ENOENT);
    assert(fabs(play(target) - baseline) < 1e-5);
    MguCarplayLiveStats s = stats();
    assert(s.bridge_active && !s.armed && !s.applied_valid && s.bridge_rejects == 0);

    /* 2. Service publishes +6 dB @100 Hz: the next write arms with a crossfade. */
    write_snapshot(snap_path, 1, 6, 1);
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_OK);
    const double fading = play(target);
    const double boosted = play(target);
    assert(fading > baseline * 1.05 && fading < boosted);
    assert(boosted > baseline * 1.45 && boosted < baseline * 2.2);
    s = stats();
    assert(s.armed && s.applied_valid && s.applied_revision == 1);
    const uint64_t publishes = s.bridge_publishes;
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_OK);
    assert(stats().bridge_publishes == publishes); /* unchanged file: no republish */

    /* Non-CarPlay streams are never touched by the bridge. */
    assert(fabs(play(other) - baseline) < 1e-5);

    /* 3. New revision -6 dB reconfigures without disarming. */
    write_snapshot(snap_path, 1, -6, 2);
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_OK);
    play(target);
    assert(play(target) < baseline * 0.7);
    assert(stats().applied_revision == 2 && stats().armed);

    /* 4. Corrupt file: fail-safe fade to bypass, then disarmed bit-exact pass-through. */
    corrupt_snapshot(snap_path);
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_ECRC);
    play(target);
    s = stats();
    assert(!s.armed && !s.applied_valid && s.bridge_rejects == 1 && s.bridge_last_error == MGU_EQ_SNAP_ECRC);
    assert(fabs(play(target) - baseline) < 1e-5);

    /* 5. Valid again, then explicitly disabled by the service (Bypass in the app). */
    write_snapshot(snap_path, 1, 6, 3);
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_OK);
    play(target);
    assert(play(target) > baseline * 1.45);
    write_snapshot(snap_path, 0, 6, 4);
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_OK);
    play(target);
    assert(!stats().armed && stats().applied_revision == 4);
    assert(fabs(play(target) - baseline) < 1e-5);

    /* 6. Rollback lever: deleting the snapshot returns to bypass. */
    write_snapshot(snap_path, 1, 6, 5);
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_OK);
    play(target);
    assert(stats().armed);
    unlink(snap_path);
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_ENOENT);
    play(target);
    assert(!stats().armed);
    assert(fabs(play(target) - baseline) < 1e-5);

    /* 7. A reopened CarPlay stream inherits the newest configuration without a new poll. */
    write_snapshot(snap_path, 1, 6, 6);
    assert(mgu_cp_live_bridge_poll(snap_path) == MGU_EQ_SNAP_OK);
    play(target);
    assert(snd_pcm_close(target) == 0);
    assert(snd_pcm_open(&target, TARGET, 0, 0) == 0);
    assert(snd_pcm_hw_params(target, &okay) == 0);
    play(target);
    assert(play(target) > baseline * 1.45);
    assert(stats().applied_revision == 6);

    /* 8. Bridge thread picks up a service change on its own. */
    assert(mgu_cp_live_bridge_start(snap_path, 20) == 0);
    assert(mgu_cp_live_bridge_start(snap_path, 20) != 0); /* single producer */
    write_snapshot(snap_path, 1, -6, 7);
    for (int i = 0; i < 200 && stats().applied_revision != 7; i++) {
        struct timespec ts = {0, 10 * 1000000L};
        nanosleep(&ts, NULL);
        play(target);
    }
    assert(stats().applied_revision == 7);
    assert(play(target) < baseline * 0.7);
    mgu_cp_live_bridge_stop();
    mgu_cp_live_bridge_stop(); /* idempotent */
    play(target);
    assert(!stats().armed && !stats().applied_valid);
    assert(fabs(play(target) - baseline) < 1e-5);

    /* 9. Stress: concurrent producer vs. audio writes (run under TSan in CI). */
    pthread_t thread;
    atomic_store(&stop_producer, 0);
    const MguCarplayLiveStats pre_stress = stats();
    assert(pthread_create(&thread, NULL, producer, NULL) == 0);
    pthread_mutex_lock(&producer_lock);
    while (!producer_has_polled) pthread_cond_wait(&producer_ready, &producer_lock);
    pthread_mutex_unlock(&producer_lock);
    for (int i = 0; i < stress; i++)
        assert(snd_pcm_writei(target, audio, 256) == 256);
    atomic_store(&stop_producer, 1);
    pthread_join(thread, NULL);
    play(target); /* Consume the final publish, even if the writer last ran after the loop. */
    s = stats();
    assert(s.bridge_publishes > pre_stress.bridge_publishes);
    assert(s.bridge_applies > pre_stress.bridge_applies && s.bridge_rejects > pre_stress.bridge_rejects);
    printf("stress: %d writes, %llu publishes, %llu applies, %llu rejects\n", stress,
           (unsigned long long)s.bridge_publishes, (unsigned long long)s.bridge_applies,
           (unsigned long long)s.bridge_rejects);

    /* 10. Manual opt-in gate: MGU_CP_LIVE_SNAPSHOT starts the bridge when the target opens. */
    write_snapshot(snap_path, 1, 6, 9000);
    assert(snd_pcm_close(target) == 0);
    assert(setenv("MGU_CP_LIVE_SNAPSHOT", snap_path, 1) == 0);
    assert(snd_pcm_open(&target, TARGET, 0, 0) == 0);
    assert(snd_pcm_hw_params(target, &okay) == 0);
    assert(mgu_cp_live_bridge_start(snap_path, 20) != 0); /* already running via the gate */
    for (int i = 0; i < 400 && stats().applied_revision != 9000; i++) {
        struct timespec ts = {0, 10 * 1000000L};
        nanosleep(&ts, NULL);
        play(target);
    }
    assert(stats().applied_revision == 9000 && stats().armed);
    mgu_cp_live_bridge_stop();
    unsetenv("MGU_CP_LIVE_SNAPSHOT");

    assert(snd_pcm_close(target) == 0);
    assert(snd_pcm_close(other) == 0);
    unlink(snap_path);
    puts("PASS: snapshot bridge arms with crossfade, reconfigures, fails safe on corrupt/missing/disabled snapshots, survives reopen, bridge thread and concurrent stress, other streams untouched");
    return 0;
}
