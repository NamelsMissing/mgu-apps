/* SPDX-License-Identifier: GPL-2.0-only */
#define _POSIX_C_SOURCE 200809L
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

enum {
    RATE = 48000, CHANNELS = 2, FRAME_BYTES = 4,
    BUFFER_US = 64000, MAX_DEVICE_FRAMES = RATE * 120 / 1000,
    MAX_BLOCK_FRAMES = RATE * 40 / 1000,
    PCM_PLAYBACK = 0, PCM_NONBLOCK = 1, PCM_INTERLEAVED = 3
};

struct alsa {
    void *library;
    int (*open)(void **, const char *, int, int);
    int (*format)(const char *);
    int (*set_params)(void *, int, int, unsigned, unsigned, int, unsigned);
    int (*get_params)(void *, unsigned long *, unsigned long *);
    int (*delay)(void *, long *);
    long (*write_frames)(void *, const void *, unsigned long);
    int (*prepare)(void *);
    int (*drop)(void *);
    int (*close)(void *);
    const char *(*error)(int);
};

struct counters {
    unsigned long buffer_frames;
    unsigned long period_frames;
    unsigned long underruns;
    unsigned long dropped;
    long pending;
};

static volatile sig_atomic_t stopping;

static void stop(int signal_number) {
    (void)signal_number;
    stopping = 1;
}

static int load_alsa(struct alsa *alsa) {
    alsa->library = dlopen("libasound.so.2", RTLD_NOW | RTLD_LOCAL);
    if (!alsa->library) {
        fprintf(stderr, "ALSA library unavailable: %s\n", dlerror());
        return -1;
    }
#define LOAD(field, name) do { \
    void *symbol = dlsym(alsa->library, name); \
    if (!symbol || sizeof(symbol) != sizeof(alsa->field)) { \
        fprintf(stderr, "ALSA symbol unavailable: %s\n", name); \
        return -1; \
    } \
    memcpy(&alsa->field, &symbol, sizeof(symbol)); \
} while (0)
    LOAD(open, "snd_pcm_open");
    LOAD(format, "snd_pcm_format_value");
    LOAD(set_params, "snd_pcm_set_params");
    LOAD(get_params, "snd_pcm_get_params");
    LOAD(delay, "snd_pcm_delay");
    LOAD(write_frames, "snd_pcm_writei");
    LOAD(prepare, "snd_pcm_prepare");
    LOAD(drop, "snd_pcm_drop");
    LOAD(close, "snd_pcm_close");
    LOAD(error, "snd_strerror");
#undef LOAD
    return 0;
}

static int usable_device(const char *name) {
    static const char *reserved[] = {
        "carplay", "androidauto", "mediasink_audioout", "hfp",
        "emergency", "ecall", "speech", "voice", "navigation", "ringtone"
    };
    char lower[161];
    size_t length = strlen(name), i;
    if (!length || length >= sizeof(lower) || !isalnum((unsigned char)name[0])) return 0;
    for (i = 0; i < length; i++) {
        unsigned char ch = (unsigned char)name[i];
        if (!isalnum(ch) && strchr("_.:,+-", ch) == NULL) return 0;
        lower[i] = (char)tolower(ch);
    }
    lower[length] = '\0';
    if (!strcmp(lower, "default") || !strncmp(lower, "hw:", 3) ||
        !strncmp(lower, "plughw:", 7) || !strncmp(lower, "plug:hw:", 8)) return 0;
    for (i = 0; i < sizeof(reserved) / sizeof(reserved[0]); i++)
        if (strstr(lower, reserved[i])) return 0;
    return 1;
}

static long long monotonic_ms(void) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time) < 0) return 0;
    return (long long)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

static void report(const struct counters *stats) {
    printf("{\"bufferFrames\":%lu,\"periodFrames\":%lu,\"pendingFrames\":%ld,"
           "\"underruns\":%lu,\"droppedFrames\":%lu}\n",
           stats->buffer_frames, stats->period_frames, stats->pending,
           stats->underruns, stats->dropped);
    fflush(stdout);
}

static int recover(const struct alsa *alsa, void *pcm, int result, struct counters *stats) {
    if (result == -EPIPE || result == -ESTRPIPE) {
        stats->underruns++;
        result = alsa->prepare(pcm);
    }
    if (result < 0) fprintf(stderr, "ALSA playback: %s\n", alsa->error(result));
    return result;
}

static int play(const struct alsa *alsa, void *pcm, struct counters *stats) {
    unsigned char input[MAX_BLOCK_FRAMES * FRAME_BYTES * 2 + FRAME_BYTES - 1];
    size_t tail = 0;
    long long last_report = monotonic_ms();
    struct pollfd source = {.fd = STDIN_FILENO, .events = POLLIN};
    report(stats);
    while (!stopping) {
        int status = poll(&source, 1, 160);
        if (status < 0 && errno == EINTR) continue;
        if (status == 0) {
            fprintf(stderr, "PCM input timed out\n");
            return 1;
        }
        if (status < 0 || (source.revents & (POLLERR | POLLNVAL))) {
            fprintf(stderr, "PCM input unavailable\n");
            return 1;
        }
        if (stopping || (source.revents & POLLHUP)) break;

        ssize_t size = read(STDIN_FILENO, input + tail, sizeof(input) - tail);
        if (size < 0 && errno == EINTR) continue;
        if (!size) break;
        if (size < 0) {
            fprintf(stderr, "PCM read: %s\n", strerror(errno));
            return 1;
        }
        size_t total = tail + (size_t)size, frames = total / FRAME_BYTES;
        unsigned char *latest = input;
        if (frames > MAX_BLOCK_FRAMES) {
            size_t discard = frames - MAX_BLOCK_FRAMES;
            latest += discard * FRAME_BYTES;
            stats->dropped += discard;
            frames -= discard;
        }
        long delay = 0;
        int result = alsa->delay(pcm, &delay);
        if (result < 0 && result != -EAGAIN && recover(alsa, pcm, result, stats) < 0) return 1;
        if (result < 0 || delay < 0) delay = 0;
        stats->pending = delay;
        size_t room = (unsigned long)delay < stats->buffer_frames ? stats->buffer_frames - (unsigned long)delay : 0;
        if (frames > room) {
            latest += (frames - room) * FRAME_BYTES;
            stats->dropped += frames - room;
            frames = room;
        }
        if (frames && !stopping) {
            long written = alsa->write_frames(pcm, latest, frames);
            if (written < 0 && written != -EAGAIN && recover(alsa, pcm, (int)written, stats) < 0) return 1;
            if (written < 0) written = 0;
            stats->pending += written;
            stats->dropped += frames - (size_t)written;
        }
        tail = total % FRAME_BYTES;
        memmove(input, input + total - tail, tail);
        long long now = monotonic_ms();
        if (now - last_report >= 350) {
            report(stats);
            last_report = now;
        }
    }
    return 0;
}

int main(int argc, char **argv) {
    struct alsa alsa = {0};
    struct counters stats = {0};
    struct sigaction action = {.sa_handler = stop};
    void *pcm = NULL;
    int status = 1;
    if (argc != 2 || !usable_device(argv[1])) {
        fprintf(stderr, "Specify a verified dedicated ALSA PCM endpoint\n");
        return 2;
    }
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    if (load_alsa(&alsa) < 0) goto done;
    int format = alsa.format("S16_LE");
    int result = format < 0 ? format : alsa.open(&pcm, argv[1], PCM_PLAYBACK, PCM_NONBLOCK);
    if (result < 0) {
        fprintf(stderr, "ALSA open: %s\n", alsa.error(result));
        goto done;
    }
    result = alsa.set_params(pcm, format, PCM_INTERLEAVED, CHANNELS, RATE, 0, BUFFER_US);
    if (result < 0 || (result = alsa.get_params(pcm, &stats.buffer_frames, &stats.period_frames)) < 0) {
        fprintf(stderr, "ALSA format negotiation: %s\n", alsa.error(result));
        goto done;
    }
    if (!stats.buffer_frames || !stats.period_frames || stats.buffer_frames > MAX_DEVICE_FRAMES) {
        fprintf(stderr, "ALSA negotiated buffer outside real-time limits\n");
        goto done;
    }
    status = play(&alsa, pcm, &stats);
done:
    if (pcm) {
        alsa.drop(pcm);
        alsa.close(pcm);
    }
    if (alsa.library) dlclose(alsa.library);
    return status;
}
