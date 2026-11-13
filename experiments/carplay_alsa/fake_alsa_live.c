/* Fake ALSA for offline-only CarPlay EQ tests. Not vehicle code. */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
typedef struct _snd_pcm { int stream; char name[96]; } snd_pcm_t;
typedef struct _snd_pcm_hw_params { int format; unsigned channels, rate; int access; } snd_pcm_hw_params_t;
static double g_rms;
static unsigned long g_frames;
static int g_short;
int snd_pcm_open(snd_pcm_t **out,const char *name,int stream,int mode) {
    (void)mode;
    if (!out||!name) return -1;
    snd_pcm_t *pcm=(snd_pcm_t *)calloc(1,sizeof(*pcm));
    if (!pcm) return -1;
    pcm->stream=stream;strncpy(pcm->name,name,sizeof(pcm->name)-1);
    *out=pcm;return 0;
}
int snd_pcm_hw_params(snd_pcm_t *pcm,snd_pcm_hw_params_t *p) {return pcm&&p?0:-1;}
int snd_pcm_hw_params_get_format(const snd_pcm_hw_params_t *p,int *out) {
    if (!p||!out) return -1;
    *out=p->format;return 0;
}
int snd_pcm_hw_params_get_channels(const snd_pcm_hw_params_t *p,unsigned *out) {
    if (!p||!out) return -1;
    *out=p->channels;return 0;
}
int snd_pcm_hw_params_get_rate(const snd_pcm_hw_params_t *p,unsigned *out,int *dir) {
    if (!p||!out||!dir) return -1;
    *out=p->rate;*dir=0;return 0;
}
int snd_pcm_hw_params_get_access(const snd_pcm_hw_params_t *p,int *out) {
    if (!p||!out) return -1;
    *out=p->access;return 0;
}
static long capture(snd_pcm_t *pcm,const void *buf,unsigned long frames) {
    if (!pcm||!buf) return -1;
    unsigned long used=g_short ? frames/2 : frames;
    g_frames=used;double sum=0;
    const int16_t *in=(const int16_t *)buf;
    for(unsigned long i=0;i<used*2;i++){double s=(double)in[i]/32768.0;sum+=s*s;}
    g_rms=used?sqrt(sum/(used*2)):0;
    return (long)used;
}
long snd_pcm_writei(snd_pcm_t *pcm,const void *buf,unsigned long f) {return capture(pcm,buf,f);}
long snd_pcm_mmap_writei(snd_pcm_t *pcm,const void *buf,unsigned long f) {return capture(pcm,buf,f);}
int snd_pcm_close(snd_pcm_t *pcm) {free(pcm);return 0;}
void fake_alsa_partial(int flag) {g_short=flag;}
double fake_alsa_rms(void) {return g_rms;}
unsigned long fake_alsa_frames(void) {return g_frames;}
