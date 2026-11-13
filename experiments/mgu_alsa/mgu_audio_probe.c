/*
 * MGU ALSA/SmartX diagnostic. No production audio streams are ever opened.
 * --test-null writes only to ALSA's verified NULL discard device.
 * SPDX-License-Identifier: MIT
 */
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#define MAX_HINTS 32

struct alsa {
    void *handle;
    const char *(*version)(void);
    const char *(*error_text)(int);
    int (*hints)(int, const char *, void ***);
    char *(*get_hint)(const void *, const char *);
    int (*free_hints)(void **);
    int (*open)(void **, const char *, int, int);
    int (*set_params)(void *, int, int, unsigned int, unsigned int, int, unsigned int);
    long (*writei)(void *, const void *, unsigned long);
    int (*recover)(void *, int, int);
    int (*drain)(void *);
    int (*close)(void *);
    int (*pcm_type)(void *);
    const char *(*pcm_type_name)(int);
    int (*format_value)(const char *);
};
static int load_symbol(void *handle, const char *name, void *out, size_t size) {
    void *symbol = dlsym(handle, name);
    if (!symbol || size != sizeof(symbol)) {
        fprintf(stderr, "ALSA_SYMBOL=missing name=%s\n", name); return -1;
    }
    memcpy(out, &symbol, sizeof(symbol));
    return 0;
}
#define GET(a, field, symbol) do { \
    if (load_symbol((a)->handle, symbol, &(a)->field, sizeof((a)->field))) return -1; \
} while (0)

static int load_alsa(struct alsa *a, int playback) {
    memset(a, 0, sizeof(*a));
    a->handle = dlopen("libasound.so.2", RTLD_NOW | RTLD_LOCAL);
    if (!a->handle) { printf("ALSA_LIBRARY=missing\n"); return -1; }
    GET(a, version, "snd_asoundlib_version");
    GET(a, error_text, "snd_strerror");
    GET(a, hints, "snd_device_name_hint");
    GET(a, get_hint, "snd_device_name_get_hint");
    GET(a, free_hints, "snd_device_name_free_hint");
    if (playback) {
        GET(a, open, "snd_pcm_open");
        GET(a, set_params, "snd_pcm_set_params");
        GET(a, writei, "snd_pcm_writei");
        GET(a, recover, "snd_pcm_recover");
        GET(a, drain, "snd_pcm_drain");
        GET(a, close, "snd_pcm_close");
        GET(a, pcm_type, "snd_pcm_type");
        GET(a, pcm_type_name, "snd_pcm_type_name");
        GET(a, format_value, "snd_pcm_format_value");
    }
    printf("ALSA_LIBRARY=available version=%s\n", a->version());
    return 0;
}
static void print_file(const char *label, const char *file) {
    printf("=== %s ===\n", label);
    FILE *f = fopen(file, "r");
    if (!f) { printf("unavailable (%s)\n", strerror(errno)); return; }
    char line[256]; int count = 0;
    while (count++ < 12 && fgets(line, sizeof(line), f)) fputs(line, stdout);
    fclose(f);
}
static int belongs_to_group(gid_t gid) {
    if (getegid() == gid) return 1;
    int count = getgroups(0, NULL);
    if (count <= 0 || count > 512) return 0;
    gid_t *groups = calloc((size_t)count, sizeof(*groups));
    if (!groups) return 0;
    int found = 0;
    if (getgroups(count, groups) == count) {
        for (int i = 0; i < count; i++) if (groups[i] == gid) found = 1;
    }
    free(groups);
    return found;
}
static const char *channel_class(const char *name) {
    if (strstr(name, "CarPlay")) return "reserved-carplay";
    if (strstr(name, "AndroidAuto")) return "reserved-androidauto";
    if (strstr(name, "MediaSink_AudioOut_Front")) return "reserved-mediaengine";
    if (strstr(name, "Voice") || strstr(name, "Speech") || strstr(name, "HFP") ||
        strstr(name, "ECNR") || strstr(name, "ECall") || strstr(name, "Tel"))
        return "reserved-voice-or-safety";
    return "unverified-do-not-open";
}
static void list_smartx(void) {
    DIR *dir = opendir("/dev/shm");
    if (!dir) { printf("SMARTX_SHM=unavailable\n"); return; }
    puts("=== SmartX endpoints (metadata only; no ringbuffers opened) ===");
    int shown = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strncmp(entry->d_name, "smartx_", 7) || !strstr(entry->d_name, "_connection")) continue;
        if (shown++ >= 200) { puts("Additional endpoints omitted"); break; }
        char file[1024];
        if (snprintf(file, sizeof(file), "/dev/shm/%s", entry->d_name) >= (int)sizeof(file)) continue;
        struct stat st;
        if (stat(file, &st)) continue;
        printf("%s uid=%lu gid=%lu mode=%03o group_member=%s class=%s\n",
            entry->d_name, (unsigned long)st.st_uid, (unsigned long)st.st_gid,
            (unsigned int)(st.st_mode & 0777),
            belongs_to_group(st.st_gid) ? "yes" : "no", channel_class(entry->d_name));
    }
    if (!shown) puts("No SmartX endpoint files");
    closedir(dir);
}
static int list_hints(struct alsa *a) {
    void **hints = NULL;
    int result = a->hints(-1, "pcm", &hints);
    if (result < 0) {
        printf("ALSA_HINTS=error %s\n", a->error_text(result)); return 1;
    }
    puts("=== ALSA PCM name hints (names only; no devices opened) ===");
    if (hints) {
        for (int i = 0; hints[i] && i < MAX_HINTS; i++) {
            char *name = a->get_hint(hints[i], "NAME");
            char *io = a->get_hint(hints[i], "IOID");
            printf("name=%s direction=%s\n", name ? name : "unknown", io ? io : "both");
            free(name); free(io);
        }
        a->free_hints(hints);
    }
    return 0;
}
static int test_null(struct alsa *a) {
    void *pcm = NULL;
    int result = a->open(&pcm, "null", 0, 0);
    if (result < 0) {
        fprintf(stderr, "NULL_PCM_OPEN=failed %s\n", a->error_text(result)); return 1;
    }
    const char *type = a->pcm_type_name(a->pcm_type(pcm));
    if (!type || (strcmp(type, "NULL") && strcmp(type, "null"))) {
        fprintf(stderr, "NULL_PCM_TEST=refused type=%s (nothing written)\n",
            type ? type : "unknown");
        a->close(pcm); return 1;
    }
    int format = a->format_value("S16_LE");
    if (format < 0) { fprintf(stderr, "NULL_PCM_FORMAT=unsupported\n"); a->close(pcm); return 1; }
    /* SND_PCM_ACCESS_RW_INTERLEAVED is defined as 3 in ALSA's public enum. */
    result = a->set_params(pcm, format, 3, 2, 48000, 0, 100000);
    if (result < 0) {
        fprintf(stderr, "NULL_PCM_PARAMS=failed %s\n", a->error_text(result));
        a->close(pcm); return 1;
    }
    int16_t buffer[480 * 2];
    const double pi = 3.14159265358979323846;
    for (int block = 0; block < 100; block++) {
        for (int frame = 0; frame < 480; frame++) {
            double seconds = (double)(block * 480 + frame) / 48000;
            int16_t sample = (int16_t)(950 * sin(2 * pi * 440 * seconds));
            buffer[frame * 2] = sample;
            buffer[frame * 2 + 1] = sample;
        }
        unsigned long remain = 480;
        const int16_t *data = buffer;
        while (remain) {
            long sent = a->writei(pcm, data, remain);
            if (sent < 0) {
                int rc = a->recover(pcm, (int)sent, 1);
                if (rc < 0) {
                    fprintf(stderr, "NULL_PCM_WRITE=failed %s\n", a->error_text(rc));
                    a->close(pcm); return 1;
                }
                continue;
            }
            if (!sent) { fputs("NULL_PCM_WRITE=zero-frames\n", stderr); a->close(pcm); return 1; }
            remain -= (unsigned long)sent; data += sent * 2;
        }
    }
    a->drain(pcm); a->close(pcm);
    puts("NULL_PCM_TEST=pass 48000Hz stereo S16_LE frames=48000 discarded=yes");
    return 0;
}
static void help(const char *program) {
    printf("Usage: %s [--status|--hints|--test-null]\n", program);
    puts("--status    DEFAULT. Read-only inventory; does not open any PCM.");
    puts("--hints     List ALSA device-name hints; no PCM open.");
    puts("--test-null Open ONLY ALSA's verified virtual NULL/discard PCM.");
    puts("This program cannot select or write to BMW/SmartX PCM endpoints.");
}
int main(int argc, char **argv) {
    if (argc > 2) { help(argv[0]); return 2; }
    const char *mode = argc == 2 ? argv[1] : "--status";
    if (!strcmp(mode, "--help")) { help(argv[0]); return 0; }
    if (strcmp(mode, "--status") && strcmp(mode, "--hints") && strcmp(mode, "--test-null")) {
        help(argv[0]); return 2;
    }
    printf("MGU_AUDIO_PROBE=1 mode=%s euid=%lu egid=%lu\n",
        mode, (unsigned long)geteuid(), (unsigned long)getegid());
    print_file("ALSA cards", "/proc/asound/cards");
    print_file("ALSA pcm", "/proc/asound/pcm");
    list_smartx();
    struct alsa a;
    int wants_pcm = !strcmp(mode, "--test-null");
    if (load_alsa(&a, wants_pcm) != 0) return !strcmp(mode, "--status") ? 0 : 3;
    int rc = 0;
    if (!strcmp(mode, "--hints")) rc = list_hints(&a) ? 4 : 0;
    if (wants_pcm) rc = test_null(&a) ? 5 : 0;
    dlclose(a.handle);
    return rc;
}
