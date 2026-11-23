/* SPDX-License-Identifier: GPL-2.0-only */
#define _GNU_SOURCE
#include "libretro.h"

#include <dlfcn.h>
#include <sys/syscall.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum { MAX_WIDTH = 768, MAX_HEIGHT = 512, MAX_AUDIO = 4096,
       MAX_ROM = 32 * 1024 * 1024, MAX_SAVE = 256 * 1024 };

static const struct { const char *id, *file; } cores[] = {
    {"gba", "gba.so"}, {"a26", "a26.so"}, {"pce", "pce.so"},
    {"vb", "vb.so"}, {"ws", "ws.so"}, {"a78", "a78.so"},
    {"ngp", "ngp.so"}
};

static struct retro_game_info_ext content;
static enum retro_pixel_format format = RETRO_PIXEL_FORMAT_0RGB1555;
static uint32_t width, height, input[2];
static uint8_t picture[MAX_WIDTH * MAX_HEIGHT * 4];
static int16_t pcm[MAX_AUDIO * 2];
static size_t samples;
static int frame_error;
static FILE *protocol;
static bool ngp;

static bool environment(unsigned cmd, void *data)
{
    switch (cmd) {
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
        if (data) *(bool *)data = true;
        return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *(bool *)data = false;
        return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
        struct retro_variable *variable = data;
        variable->value = NULL;
        if (!strcmp(variable->key, "gpsp_bios")) variable->value = "builtin";
        return variable->value != NULL;
    }
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
        enum retro_pixel_format value = *(enum retro_pixel_format *)data;
        if (value != RETRO_PIXEL_FORMAT_XRGB8888 &&
            value != RETRO_PIXEL_FORMAT_RGB565 && value != RETRO_PIXEL_FORMAT_0RGB1555) return false;
        format = value;
        return true;
    }
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        if (!ngp) return false;
        /* Beetle NGP's standalone flash files are outside the SRAM protocol. */
        *(const char **)data = "/dev/null";
        return true;
    case RETRO_ENVIRONMENT_GET_GAME_INFO_EXT:
        if (!content.data) return false;
        *(const struct retro_game_info_ext **)data = &content;
        return true;
    case RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
        return true;
    default:
        return false;
    }
}

static void video(const void *data, unsigned w, unsigned h, size_t pitch)
{
    unsigned bytes = format == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
    if (!data) return; /* Repeat the last frame. */
    if (!w || !h || w > MAX_WIDTH || h > MAX_HEIGHT || pitch < w * bytes) {
        frame_error = 1;
        return;
    }
    width = w;
    height = h;
    for (unsigned y = 0; y < h; y++) {
        const uint8_t *row = (const uint8_t *)data + pitch * y;
        uint8_t *out = picture + y * w * 4;
        for (unsigned x = 0; x < w; x++, out += 4) {
            if (bytes == 4) {
                out[0] = row[x * 4 + 2];
                out[1] = row[x * 4 + 1];
                out[2] = row[x * 4];
            } else {
                unsigned p = row[x * 2] | ((unsigned)row[x * 2 + 1] << 8);
                unsigned rgb565 = format == RETRO_PIXEL_FORMAT_RGB565;
                out[0] = ((p >> (10 + rgb565)) & 31) * 255 / 31;
                out[1] = ((p >> 5) & (rgb565 ? 63 : 31)) * 255 / (rgb565 ? 63 : 31);
                out[2] = (p & 31) * 255 / 31;
            }
            out[3] = 255;
        }
    }
}

static size_t audio_batch(const int16_t *data, size_t count)
{
    size_t accepted = count < MAX_AUDIO - samples ? count : MAX_AUDIO - samples;
    memcpy(pcm + samples * 2, data, accepted * 2 * sizeof(*data));
    samples += accepted;
    return count;
}

static void audio_sample(int16_t left, int16_t right)
{
    int16_t pair[2] = {left, right};
    audio_batch(pair, 1);
}

static void poll_input(void) {}

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id)
{
    if (port >= 2 || device != RETRO_DEVICE_JOYPAD || index != 0) return 0;
    if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)input[port];
    return id < 16 && ((input[port] >> id) & 1);
}

static void *load_core(const char *id)
{
    char file[4096];
    const char *leaf = NULL;
    for (size_t i = 0; i < sizeof(cores) / sizeof(*cores); i++)
        if (!strcmp(cores[i].id, id)) leaf = cores[i].file;
    if (!leaf) return NULL;
    ssize_t len = readlink("/proc/self/exe", file, sizeof(file) - 1);
    if (len < 0 || (size_t)len == sizeof(file) - 1) return NULL;
    file[len] = '\0';
    char *slash = strrchr(file, '/');
    if (!slash || strlen(leaf) >= sizeof(file) - (size_t)(slash + 1 - file)) return NULL;
    strcpy(slash + 1, leaf);
    return dlopen(file, RTLD_NOW | RTLD_LOCAL);
}

static int send_packet(const uint32_t *header, size_t words, const void *save, size_t save_size)
{
    size_t pixels_size = (size_t)width * height * 4;
    if (fwrite(header, 4, words, protocol) != words) return -1;
    if (pixels_size && fwrite(picture, 1, pixels_size, protocol) != pixels_size) return -1;
    if (samples && fwrite(pcm, 4, samples, protocol) != samples) return -1;
    if (save_size && fwrite(save, 1, save_size, protocol) != save_size) return -1;
    return fflush(protocol);
}

/* gpSP streams cartridge pages. Keep its file path backed by a private,
 * already unlinked file so quitting or killing the helper leaves no ROM file. */
static int rom_file(const uint8_t *rom, size_t size, char *path, size_t capacity)
{
    int fd = -1;
#ifdef SYS_memfd_create
    fd = syscall(SYS_memfd_create, "gamestation-cart", 0);
#endif
    if (fd < 0) {
        char tmp[] = "/tmp/mgu-retro-XXXXXX";
        fd = mkstemp(tmp);
        if (fd >= 0 && unlink(tmp) < 0) { close(fd); return -1; }
    }
    if (fd < 0) return -1;
    for (size_t written = 0; written < size;) {
        ssize_t count = write(fd, rom + written, size - written);
        if (count <= 0) { close(fd); return -1; }
        written += (size_t)count;
    }
    snprintf(path, capacity, "/proc/self/fd/%d", fd);
    return fd;
}

int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    int output = dup(STDOUT_FILENO);
    if (output < 0 || dup2(STDERR_FILENO, STDOUT_FILENO) < 0) return 2;
    protocol = fdopen(output, "wb");
    if (!protocol) return 2;
    const char *ext = strrchr(argv[2], '.');
    if (!ext || strchr(argv[2], '/') || strchr(argv[2], '\\')) return 2;
    ngp = !strcmp(argv[1], "ngp");
    void *core = load_core(argv[1]);
    if (!core) {
        const char *error = dlerror();
        fprintf(stderr, "Could not load retro core%s%s\n", error ? ": " : "", error ? error : "");
        return 2;
    }
#define IMPORT(kind, name, args) \
    kind (*name) args; do { \
        void *symbol = dlsym(core, #name); \
        if (!symbol) { fprintf(stderr, "Missing " #name "\n"); return 2; } \
        memcpy(&name, &symbol, sizeof(name)); \
    } while (0)
    IMPORT(unsigned, retro_api_version, (void));
    IMPORT(void, retro_set_environment, (retro_environment_t));
    IMPORT(void, retro_set_video_refresh, (retro_video_refresh_t));
    IMPORT(void, retro_set_audio_sample, (retro_audio_sample_t));
    IMPORT(void, retro_set_audio_sample_batch, (retro_audio_sample_batch_t));
    IMPORT(void, retro_set_input_poll, (retro_input_poll_t));
    IMPORT(void, retro_set_input_state, (retro_input_state_t));
    IMPORT(void, retro_init, (void));
    IMPORT(void, retro_deinit, (void));
    IMPORT(bool, retro_load_game, (const struct retro_game_info *));
    IMPORT(void, retro_get_system_av_info, (struct retro_system_av_info *));
    IMPORT(size_t, retro_get_memory_size, (unsigned));
    IMPORT(void *, retro_get_memory_data, (unsigned));
    IMPORT(void, retro_run, (void));
    IMPORT(void, retro_unload_game, (void));
#undef IMPORT

    uint32_t sizes[2];
    if (retro_api_version() != RETRO_API_VERSION || fread(sizes, 4, 2, stdin) != 2 ||
        !sizes[0] || sizes[0] > MAX_ROM || sizes[1] > MAX_SAVE) return 2;
    uint8_t *rom = malloc(sizes[0]), *before = malloc(MAX_SAVE);
    if (!rom || !before || fread(rom, 1, sizes[0], stdin) != sizes[0] ||
        fread(before, 1, sizes[1], stdin) != sizes[1]) return 2;
    char stem[121];
    size_t stem_length = (size_t)(ext - argv[2]);
    if (!stem_length || stem_length >= sizeof(stem)) return 2;
    memcpy(stem, argv[2], stem_length);
    stem[stem_length] = '\0';
    content.full_path = argv[2];
    content.name = stem;
    content.ext = ext + 1;
    content.data = rom;
    content.size = sizes[0];
    content.persistent_data = true;
    char filename[64];
    int cart = -1;
    if (!strcmp(argv[1], "gba")) {
        cart = rom_file(rom, sizes[0], filename, sizeof(filename));
        if (cart < 0) { fprintf(stderr, "Could not prepare cartridge file\n"); return 2; }
    }
    const struct retro_game_info game = {.path = cart >= 0 ? filename : argv[2], .data = rom, .size = sizes[0]};
    retro_set_environment(environment);
    retro_set_video_refresh(video);
    retro_set_audio_sample(audio_sample);
    retro_set_audio_sample_batch(audio_batch);
    retro_set_input_poll(poll_input);
    retro_set_input_state(input_state);
    retro_init();
    if (!retro_load_game(&game)) {
        fprintf(stderr, "Retro core rejected the cartridge\n");
        return 2;
    }
    struct retro_system_av_info info = {0};
    retro_get_system_av_info(&info);
    if (!(info.timing.fps >= 10 && info.timing.fps <= 100) ||
        !(info.timing.sample_rate >= 8000 && info.timing.sample_rate <= 192000)) {
        fprintf(stderr, "Unsupported core timing\n");
        return 2;
    }
    size_t save_size = retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);
    void *save = retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
    if (!save || save_size > MAX_SAVE) save_size = 0;
    bool have_save = save_size && save_size == sizes[1];
    if (have_save) memcpy(save, before, save_size);
    uint32_t ready[6] = {1, (uint32_t)(info.timing.fps * 1000 + 0.5),
                         (uint32_t)(info.timing.sample_rate + 0.5), 0, 0, 0};
    width = height = samples = 0;
    if (send_packet(ready, 6, NULL, 0) < 0) return 1;
    while (fread(input, 4, 2, stdin) == 2) {
        samples = 0;
        retro_run();
        if (frame_error) {
            fprintf(stderr, "Invalid retro video frame\n");
            return 2;
        }
        bool changed = save_size && (!have_save || memcmp(save, before, save_size));
        uint32_t frame[6] = {2, width, height, (uint32_t)samples,
                             changed ? (uint32_t)save_size : 0, 0};
        if (send_packet(frame, 6, save, frame[4]) < 0) return 1;
        if (changed) { memcpy(before, save, save_size); have_save = true; }
    }
    retro_unload_game();
    retro_deinit();
    free(rom);
    free(before);
    dlclose(core);
    if (cart >= 0) close(cart);
    fclose(protocol);
    return 0;
}
