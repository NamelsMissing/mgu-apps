/*
 * Offline-only native CarPlay PCM EQ interposer experiment.
 * NOT an installable MGU component, no BMW/CarPlay process changes.
 * Exact stream gate, disabled by default, fail-open and reversible.
 * Copyright 2026 NamelsMissing contributors. SPDX-License-Identifier: MIT
 */
#define _GNU_SOURCE
#include "carplay_live_filter.h"
#include "eq_snapshot.h"
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct _snd_pcm snd_pcm_t;
typedef struct _snd_pcm_hw_params snd_pcm_hw_params_t;
typedef unsigned long snd_pcm_uframes_t;
typedef long snd_pcm_sframes_t;
typedef int (*OpenFn)(snd_pcm_t **, const char *, int, int);
typedef int (*ParamsFn)(snd_pcm_t *, snd_pcm_hw_params_t *);
typedef int (*GetFormatFn)(const snd_pcm_hw_params_t *, int *);
typedef int (*GetChannelsFn)(const snd_pcm_hw_params_t *, unsigned *);
typedef int (*GetRateFn)(const snd_pcm_hw_params_t *, unsigned *, int *);
typedef int (*GetAccessFn)(const snd_pcm_hw_params_t *, int *);
typedef snd_pcm_sframes_t (*WriteFn)(snd_pcm_t *, const void *, snd_pcm_uframes_t);
typedef int (*CloseFn)(snd_pcm_t *);

#define ACCESS_MMAP_INTERLEAVED 0
#define ACCESS_RW_INTERLEAVED 3
#define MAX_WRITE_FRAMES 4096UL
#define TARGET "smartx:CarPlayMain_CF_48_STEREO"

static pthread_once_t g_once = PTHREAD_ONCE_INIT;
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static OpenFn g_open;
static ParamsFn g_params;
static GetFormatFn g_format_get;
static GetChannelsFn g_channels_get;
static GetRateFn g_rate_get;
static GetAccessFn g_access_get;
static WriteFn g_write, g_mmap_write;
static CloseFn g_close;
static snd_pcm_t *g_target;
static int g_format = -1, g_access = -1;
static unsigned g_channels, g_rate;
static int g_negotiated;
static _Atomic(int) g_armed;
static MguEqDsp g_dsp;
static _Atomic(uint64_t) g_write_calls, g_processed_frames, g_bypassed_frames;
static _Atomic(uint64_t) g_mmap_calls, g_unsupported, g_partials;
static _Thread_local uint8_t g_scratch[MAX_WRITE_FRAMES * 2 * 4];

/* ---- Snapshot bridge: wait-free triple buffer (one producer, one consumer) ----
 * Slot ownership: the producer owns g_back, the audio thread owns g_front and the
 * shared index g_middle is exchanged atomically. DIRTY marks an unread middle. */
typedef struct { int valid; uint32_t revision; MguEqConfig config; } BridgeSlot;
#define BRIDGE_DIRTY 4u
#define BRIDGE_PATH_MAX 256
static BridgeSlot g_slots[3];
static _Atomic(unsigned) g_middle = 1;
static unsigned g_back = 0;            /* producer side, g_bridge_lock */
static unsigned g_front = 2;           /* consumer side, g_lock */
static pthread_mutex_t g_bridge_lock = PTHREAD_MUTEX_INITIALIZER; /* never taken by audio */
static int g_pub_have, g_pub_valid;    /* producer: last published state */
static uint32_t g_pub_revision;
static MguEqConfig g_pub_config;
static _Atomic(int) g_bridge_active, g_bridge_stop, g_bridge_last_error;
static _Atomic(uint64_t) g_bridge_polls, g_bridge_publishes, g_bridge_rejects, g_bridge_applies;
static pthread_t g_bridge_thread;
static pthread_mutex_t g_bridge_ctl_lock = PTHREAD_MUTEX_INITIALIZER; /* start/stop only */
static int g_bridge_thread_running;    /* g_bridge_ctl_lock */
static char g_bridge_path[BRIDGE_PATH_MAX];
static unsigned g_bridge_interval_ms;
/* Consumer state, all under g_lock. */
static int g_have_desired, g_desired_dirty, g_fading_out, g_applied_valid;
static uint32_t g_applied_revision;

static void resolve_symbols(void) {
    *(void **)(&g_open) = dlsym(RTLD_NEXT, "snd_pcm_open");
    *(void **)(&g_params) = dlsym(RTLD_NEXT, "snd_pcm_hw_params");
    *(void **)(&g_format_get) = dlsym(RTLD_NEXT, "snd_pcm_hw_params_get_format");
    *(void **)(&g_channels_get) = dlsym(RTLD_NEXT, "snd_pcm_hw_params_get_channels");
    *(void **)(&g_rate_get) = dlsym(RTLD_NEXT, "snd_pcm_hw_params_get_rate");
    *(void **)(&g_access_get) = dlsym(RTLD_NEXT, "snd_pcm_hw_params_get_access");
    *(void **)(&g_write) = dlsym(RTLD_NEXT, "snd_pcm_writei");
    *(void **)(&g_mmap_write) = dlsym(RTLD_NEXT, "snd_pcm_mmap_writei");
    *(void **)(&g_close) = dlsym(RTLD_NEXT, "snd_pcm_close");
}
static int is_target(snd_pcm_t *pcm) {
    return pcm && g_target == pcm;
}
static void reset_stats(void) {
    atomic_store(&g_write_calls, 0);
    atomic_store(&g_processed_frames, 0);
    atomic_store(&g_bypassed_frames, 0);
    atomic_store(&g_mmap_calls, 0);
    atomic_store(&g_unsupported, 0);
    atomic_store(&g_partials, 0);
}
static void clear_stream(void) {
    atomic_store(&g_armed, 0);
    g_negotiated = 0; g_format = -1; g_access = -1; g_channels = 0; g_rate = 0;
    memset(&g_dsp, 0, sizeof(g_dsp));
    /* A new or renegotiated stream picks up the newest bridge configuration. */
    g_desired_dirty = g_have_desired; g_fading_out = 0;
}
static int config_equal(const MguEqConfig *a, const MguEqConfig *b) {
    if (a->enabled != b->enabled || a->auto_headroom != b->auto_headroom || a->preamp_db != b->preamp_db) return 0;
    for (int i = 0; i < MGU_EQ_BANDS; ++i)
        if (a->bands[i].frequency_hz != b->bands[i].frequency_hz || a->bands[i].gain_db != b->bands[i].gain_db ||
            a->bands[i].q != b->bands[i].q) return 0;
    return 1;
}
/* Producer, g_bridge_lock held. Publishes only real state changes. */
static void bridge_publish(int valid, uint32_t revision, const MguEqConfig *config) {
    if (g_pub_have && g_pub_valid == valid &&
        (!valid || (g_pub_revision == revision && config_equal(&g_pub_config, config)))) return;
    BridgeSlot *slot = &g_slots[g_back];
    slot->valid = valid; slot->revision = revision;
    if (valid) slot->config = *config; else mgu_eq_defaults(&slot->config);
    g_back = atomic_exchange_explicit(&g_middle, g_back | BRIDGE_DIRTY, memory_order_acq_rel) & 3u;
    g_pub_have = 1; g_pub_valid = valid; g_pub_revision = revision;
    if (valid) g_pub_config = *config;
    atomic_fetch_add(&g_bridge_publishes, 1);
}
/* Consumer, audio thread with g_lock held: wait-free, no I/O, no blocking. */
static void bridge_consume(void) {
    if (!(atomic_load_explicit(&g_middle, memory_order_acquire) & BRIDGE_DIRTY)) return;
    g_front = atomic_exchange_explicit(&g_middle, g_front, memory_order_acq_rel) & 3u;
    g_have_desired = 1; g_desired_dirty = 1;
}
static void bridge_apply(void) {
    const BridgeSlot *d = &g_slots[g_front];
    g_desired_dirty = 0;
    g_applied_valid = d->valid; g_applied_revision = d->revision;
    atomic_fetch_add(&g_bridge_applies, 1);
    if (d->valid && d->config.enabled) {
        if (atomic_load(&g_armed)) {
            if (mgu_eq_configure(&g_dsp, &d->config) != 0) goto fail;
        } else {
            /* Start from an exact bypass bank so arming crossfades in. */
            MguEqConfig off = d->config; off.enabled = 0;
            if (mgu_eq_init(&g_dsp, g_rate, g_channels, &off) != 0 ||
                mgu_eq_configure(&g_dsp, &d->config) != 0) goto fail;
            atomic_store(&g_armed, 1);
        }
        g_fading_out = 0;
        return;
    }
    if (atomic_load(&g_armed)) {
        MguEqConfig off; mgu_eq_defaults(&off); /* enabled = 0 */
        if (mgu_eq_configure(&g_dsp, &off) != 0) goto fail;
        g_fading_out = 1; /* disarm once the crossfade to bypass has finished */
    }
    return;
fail:
    atomic_store(&g_armed, 0); g_fading_out = 0;
    atomic_fetch_add(&g_unsupported, 1);
}
void mgu_cp_live_snapshot(MguCarplayLiveStats *out) {
    if (!out) return;
    pthread_mutex_lock(&g_lock);
    out->target_open = g_target != NULL;
    out->negotiated = g_negotiated;
    out->armed = atomic_load(&g_armed);
    out->format = g_format;
    out->access = g_access;
    out->channels = g_channels;
    out->rate = g_rate;
    out->intercepted_writes = atomic_load(&g_write_calls);
    out->processed_frames = atomic_load(&g_processed_frames);
    out->bypassed_frames = atomic_load(&g_bypassed_frames);
    out->mmap_writes = atomic_load(&g_mmap_calls);
    out->unsupported_calls = atomic_load(&g_unsupported);
    out->partial_writes = atomic_load(&g_partials);
    out->bridge_active = atomic_load(&g_bridge_active);
    out->applied_valid = g_applied_valid;
    out->applied_revision = g_applied_revision;
    out->bridge_polls = atomic_load(&g_bridge_polls);
    out->bridge_publishes = atomic_load(&g_bridge_publishes);
    out->bridge_rejects = atomic_load(&g_bridge_rejects);
    out->bridge_applies = atomic_load(&g_bridge_applies);
    out->bridge_last_error = atomic_load(&g_bridge_last_error);
    pthread_mutex_unlock(&g_lock);
}
int mgu_cp_live_arm(const MguEqConfig *config) {
    if (!config || !config->enabled) return -EINVAL;
    pthread_mutex_lock(&g_lock);
    int ok = g_target && g_negotiated && mgu_eq_sample_bytes(g_format) &&
        g_rate == 48000 && g_channels == 2 && (g_access==ACCESS_MMAP_INTERLEAVED || g_access==ACCESS_RW_INTERLEAVED) && mgu_eq_valid(config, g_rate);
    if (ok) {
        ok = mgu_eq_init(&g_dsp, g_rate, g_channels, config) == 0;
        if (ok) atomic_store(&g_armed, 1);
    }
    pthread_mutex_unlock(&g_lock);
    return ok ? 0 : -ENOTSUP;
}
int mgu_cp_live_reconfigure(const MguEqConfig *config) {
    if (!config) return -EINVAL;
    pthread_mutex_lock(&g_lock);
    int ok = g_target && g_negotiated && atomic_load(&g_armed) &&
        mgu_eq_valid(config, g_rate) && mgu_eq_configure(&g_dsp, config) == 0;
    pthread_mutex_unlock(&g_lock);
    return ok ? 0 : -ENOTSUP;
}
void mgu_cp_live_disarm(void) { atomic_store(&g_armed, 0); }

int mgu_cp_live_bridge_poll(const char *path) {
    MguEqSnapshot snap;
    const int rc = mgu_eq_snapshot_read(path, &snap);
    pthread_mutex_lock(&g_bridge_lock);
    atomic_store(&g_bridge_active, 1);
    atomic_fetch_add(&g_bridge_polls, 1);
    atomic_store(&g_bridge_last_error, rc);
    if (rc == MGU_EQ_SNAP_OK) bridge_publish(1, snap.revision, &snap.config);
    else {
        if (rc != MGU_EQ_SNAP_ENOENT) atomic_fetch_add(&g_bridge_rejects, 1);
        bridge_publish(0, 0, NULL); /* fail-safe: missing or corrupt -> bypass */
    }
    pthread_mutex_unlock(&g_bridge_lock);
    return rc;
}
static void *bridge_main(void *arg) {
    (void)arg;
    while (!atomic_load(&g_bridge_stop)) {
        (void)mgu_cp_live_bridge_poll(g_bridge_path);
        for (unsigned waited = 0; waited < g_bridge_interval_ms && !atomic_load(&g_bridge_stop); waited += 10) {
            struct timespec ts = {0, 10 * 1000000L};
            nanosleep(&ts, NULL);
        }
    }
    return NULL;
}
int mgu_cp_live_bridge_start(const char *path, unsigned interval_ms) {
    if (!path || !*path || strlen(path) >= BRIDGE_PATH_MAX || interval_ms < 20 || interval_ms > 5000) return -EINVAL;
    pthread_mutex_lock(&g_bridge_ctl_lock);
    if (g_bridge_thread_running) { pthread_mutex_unlock(&g_bridge_ctl_lock); return -EALREADY; }
    strcpy(g_bridge_path, path);
    g_bridge_interval_ms = interval_ms;
    atomic_store(&g_bridge_stop, 0);
    /* The helper thread must never receive the host process's signals. */
    sigset_t all, old;
    sigfillset(&all);
    pthread_sigmask(SIG_SETMASK, &all, &old);
    const int rc = pthread_create(&g_bridge_thread, NULL, bridge_main, NULL);
    pthread_sigmask(SIG_SETMASK, &old, NULL);
    if (rc == 0) g_bridge_thread_running = 1;
    pthread_mutex_unlock(&g_bridge_ctl_lock);
    return rc == 0 ? 0 : -rc;
}
void mgu_cp_live_bridge_stop(void) {
    /* The bridge thread never takes g_bridge_ctl_lock, so joining under it is safe
     * and keeps a concurrent start from racing a thread that is still exiting. */
    pthread_mutex_lock(&g_bridge_ctl_lock);
    if (g_bridge_thread_running) {
        atomic_store(&g_bridge_stop, 1);
        pthread_join(g_bridge_thread, NULL);
        g_bridge_thread_running = 0;
    }
    pthread_mutex_lock(&g_bridge_lock);
    bridge_publish(0, 0, NULL);
    atomic_store(&g_bridge_active, 0);
    pthread_mutex_unlock(&g_bridge_lock);
    pthread_mutex_unlock(&g_bridge_ctl_lock);
}

int snd_pcm_open(snd_pcm_t **pcm, const char *name, int stream, int mode) {
    pthread_once(&g_once, resolve_symbols);
    if (!g_open) return -ENOSYS;
    int rc = g_open(pcm, name, stream, mode);
    if (rc != 0 || !pcm || !*pcm || !name || stream != 0 || strcmp(name, TARGET)) return rc;
    pthread_mutex_lock(&g_lock);
    /* Only one independently identified stereo media stream at a time.
     * A second matching open does not replace an already tracked handle. */
    if (!g_target) { g_target = *pcm; clear_stream(); reset_stats(); }
    pthread_mutex_unlock(&g_lock);
    /* Manual opt-in gate: the bridge only runs when explicitly configured. */
    const char *snapshot = getenv("MGU_CP_LIVE_SNAPSHOT");
    if (snapshot && *snapshot) (void)mgu_cp_live_bridge_start(snapshot, 250);
    return rc;
}
int snd_pcm_hw_params(snd_pcm_t *pcm, snd_pcm_hw_params_t *params) {
    pthread_once(&g_once, resolve_symbols);
    if (!g_params) return -ENOSYS;
    int rc = g_params(pcm, params);
    pthread_mutex_lock(&g_lock);
    if (is_target(pcm)) {
        clear_stream();
        int format = -1, access = -1, direction = 0; unsigned channels = 0, rate = 0;
        if (!rc && params && g_format_get && g_channels_get && g_rate_get && g_access_get &&
            !g_format_get(params, &format) && !g_channels_get(params, &channels) &&
            !g_rate_get(params, &rate, &direction) && !g_access_get(params, &access)) {
            g_format = format; g_channels = channels; g_rate = rate; g_access = access;
            g_negotiated = mgu_eq_sample_bytes(format) && channels == 2 && rate == 48000 &&
                (access == ACCESS_RW_INTERLEAVED || access == ACCESS_MMAP_INTERLEAVED);
        } else atomic_fetch_add(&g_unsupported, 1);
    }
    pthread_mutex_unlock(&g_lock);
    return rc;
}
static snd_pcm_sframes_t filter_write(snd_pcm_t *pcm, const void *buf,
                                       snd_pcm_uframes_t frames, WriteFn original,
                                       int required_access, int is_mmap) {
    if (!original) return -ENOSYS;
    if (!pcm || !buf || !frames) return original(pcm, buf, frames);
    if (pthread_mutex_trylock(&g_lock) != 0) return original(pcm, buf, frames);
    if (!is_target(pcm)) { pthread_mutex_unlock(&g_lock); return original(pcm, buf, frames); }
    if (is_mmap) atomic_fetch_add(&g_mmap_calls, 1);
    else atomic_fetch_add(&g_write_calls, 1);
    if (g_access != required_access) {
        /* Do not mix filtered and unfiltered writes if a stream unexpectedly
         * switches between RW/MMAP access modes. */
        atomic_store(&g_armed, 0);
        g_negotiated = 0;
        atomic_fetch_add(&g_unsupported, 1);
        atomic_fetch_add(&g_bypassed_frames, frames);
        pthread_mutex_unlock(&g_lock);
        return original(pcm, buf, frames);
    }
    bridge_consume();
    if (g_desired_dirty && g_negotiated) bridge_apply();
    if (!atomic_load(&g_armed) || !g_negotiated || frames > MAX_WRITE_FRAMES) {
        if (frames > MAX_WRITE_FRAMES) atomic_fetch_add(&g_unsupported, 1);
        atomic_fetch_add(&g_bypassed_frames, frames);
        pthread_mutex_unlock(&g_lock);
        return original(pcm, buf, frames);
    }
    MguEqDsp previous = g_dsp; /* rollback snapshot for short/error writes */
    if (mgu_eq_process(&g_dsp, g_format, buf, g_scratch, frames) != 0) {
        g_dsp = previous;
        atomic_fetch_add(&g_unsupported, 1);
        atomic_fetch_add(&g_bypassed_frames, frames);
        pthread_mutex_unlock(&g_lock);
        return original(pcm, buf, frames);
    }
    snd_pcm_sframes_t result = original(pcm, g_scratch, frames);
    if (result < (snd_pcm_sframes_t)frames) {
        atomic_fetch_add(&g_partials, 1);
        g_dsp = previous;
        if (result > 0)
            (void)mgu_eq_process(&g_dsp, g_format, buf, g_scratch, (size_t)result);
    }
    if (result > 0) atomic_fetch_add(&g_processed_frames, (uint64_t)result);
    if (g_fading_out && !g_dsp.fading) { atomic_store(&g_armed, 0); g_fading_out = 0; }
    pthread_mutex_unlock(&g_lock);
    return result;
}
snd_pcm_sframes_t snd_pcm_writei(snd_pcm_t *pcm, const void *buf, snd_pcm_uframes_t frames) {
    pthread_once(&g_once, resolve_symbols);
    return filter_write(pcm, buf, frames, g_write, ACCESS_RW_INTERLEAVED, 0);
}
snd_pcm_sframes_t snd_pcm_mmap_writei(snd_pcm_t *pcm, const void *buf, snd_pcm_uframes_t frames) {
    pthread_once(&g_once, resolve_symbols);
    return filter_write(pcm, buf, frames, g_mmap_write, ACCESS_MMAP_INTERLEAVED, 1);
}
int snd_pcm_close(snd_pcm_t *pcm) {
    pthread_once(&g_once, resolve_symbols);
    if (!g_close) return -ENOSYS;
    pthread_mutex_lock(&g_lock);
    if (is_target(pcm)) { g_target = NULL; clear_stream(); }
    pthread_mutex_unlock(&g_lock);
    return g_close(pcm);
}
