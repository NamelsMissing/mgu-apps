/* Minimal libasound test double. The first write needs underrun recovery. */
#include <errno.h>

static int calls;
static int prepared;

int snd_pcm_open(void **pcm, const char *name, int stream, int mode)
{
    (void)name; (void)stream; (void)mode;
    *pcm = &calls;
    return 0;
}

int snd_pcm_format_value(const char *name) { (void)name; return 2; }

int snd_pcm_set_params(void *pcm, int format, int access, unsigned channels, unsigned rate,
                       int resample, unsigned latency)
{
    (void)pcm; (void)format; (void)access; (void)resample; (void)latency;
    return channels == 2 && rate == 48000 ? 0 : -EINVAL;
}

int snd_pcm_get_params(void *pcm, unsigned long *buffer, unsigned long *period)
{
    (void)pcm;
    *buffer = 3072; *period = 768;
    return 0;
}
int snd_pcm_delay(void *pcm, long *delay) { (void)pcm; *delay = 0; return 0; }
int snd_pcm_prepare(void *pcm) { (void)pcm; prepared++; return 0; }
int snd_pcm_drop(void *pcm) { (void)pcm; return 0; }
int snd_pcm_close(void *pcm) { (void)pcm; return 0; }
const char *snd_strerror(int error) { (void)error; return "mock PCM error"; }

long snd_pcm_writei(void *pcm, const void *frames, unsigned long count)
{
    (void)pcm; (void)frames;
    if (++calls == 1) return -EPIPE;
    return prepared ? (long)count : -EINVAL;
}
