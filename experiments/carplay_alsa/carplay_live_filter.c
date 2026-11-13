/*
 * Offline-only native CarPlay PCM EQ interposer experiment.
 * NOT an installable MGU component, no BMW/CarPlay process changes.
 * Exact stream gate, disabled by default, fail-open and reversible.
 * Copyright 2026 NamelsMissing contributors. SPDX-License-Identifier: MIT
 */
#define _GNU_SOURCE
#include "carplay_live_filter.h"
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>

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

#define SND_PCM_FORMAT_S16_LE_VALUE 2
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
static _Thread_local int16_t g_scratch[MAX_WRITE_FRAMES * 2];

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
    pthread_mutex_unlock(&g_lock);
}
int mgu_cp_live_arm(const MguEqConfig *config) {
    if (!config || !config->enabled) return -EINVAL;
    pthread_mutex_lock(&g_lock);
    int ok = g_target && g_negotiated && g_format == SND_PCM_FORMAT_S16_LE_VALUE &&
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
    return rc;
}
int snd_pcm_hw_params(snd_pcm_t *pcm, snd_pcm_hw_params_t *params) {
    pthread_once(&g_once, resolve_symbols);
    if (!g_params) return -ENOSYS;
    int rc = g_params(pcm, params);
    if (rc || !params || !g_format_get || !g_channels_get || !g_rate_get || !g_access_get) return rc;
    pthread_mutex_lock(&g_lock);
    if (is_target(pcm)) {
        clear_stream();
        int format = -1, access = -1, direction = 0; unsigned channels = 0, rate = 0;
        if (!g_format_get(params, &format) && !g_channels_get(params, &channels) &&
            !g_rate_get(params, &rate, &direction) && !g_access_get(params, &access)) {
            g_format = format; g_channels = channels; g_rate = rate; g_access = access;
            g_negotiated = format == SND_PCM_FORMAT_S16_LE_VALUE && channels == 2 && rate == 48000 &&
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
    if (!atomic_load(&g_armed) || !g_negotiated || frames > MAX_WRITE_FRAMES) {
        if (frames > MAX_WRITE_FRAMES) atomic_fetch_add(&g_unsupported, 1);
        atomic_fetch_add(&g_bypassed_frames, frames);
        pthread_mutex_unlock(&g_lock);
        return original(pcm, buf, frames);
    }
    MguEqDsp previous = g_dsp; /* rollback snapshot for short/error writes */
    if (mgu_eq_process_s16le(&g_dsp, (const int16_t *)buf, g_scratch, frames) != 0) {
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
            (void)mgu_eq_process_s16le(&g_dsp, (const int16_t *)buf, g_scratch, (size_t)result);
    }
    if (result > 0) atomic_fetch_add(&g_processed_frames, (uint64_t)result);
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
