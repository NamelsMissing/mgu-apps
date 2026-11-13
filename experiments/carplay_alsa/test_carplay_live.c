#include "carplay_live_filter.h"
#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef struct _snd_pcm snd_pcm_t;
typedef struct _snd_pcm_hw_params {int format;unsigned channels,rate;} snd_pcm_hw_params_t;
int snd_pcm_open(snd_pcm_t **,const char *,int,int);
int snd_pcm_hw_params(snd_pcm_t *,snd_pcm_hw_params_t *);
long snd_pcm_writei(snd_pcm_t *,const void *,unsigned long);
long snd_pcm_mmap_writei(snd_pcm_t *,const void *,unsigned long);
int snd_pcm_close(snd_pcm_t *);
void fake_alsa_partial(int);
double fake_alsa_rms(void);
unsigned long fake_alsa_frames(void);
#define FRAMES 4096
static int16_t audio[FRAMES*2];
static void signal100(void) {
    for (int i=0;i<FRAMES;i++) {
        double t=(double)i/48000;
        int16_t v=(int16_t)lround(0.085*32767*sin(2*3.141592653589793*100*t));
        audio[i*2]=v;audio[i*2+1]=v;
    }
}
int main(void){
    signal100();
    MguCarplayLiveStats s;
    snd_pcm_t *other=0,*target=0;
    snd_pcm_hw_params_t okay={2,2,48000}, wrong={6,2,48000};
    MguEqConfig config;mgu_eq_defaults(&config);
    config.enabled=1;config.auto_headroom=0;config.bands[0].gain_db=6;
    assert(snd_pcm_open(&other,"smartx:CarPlayAlternate_CF_24_MONO",0,0)==0);
    assert(snd_pcm_hw_params(other,&okay)==0);
    assert(mgu_cp_live_arm(&config)!=0);
    assert(snd_pcm_writei(other,audio,FRAMES)==FRAMES);
    double baseline=fake_alsa_rms();

    assert(snd_pcm_open(&target,"smartx:CarPlayMain_CF_48_STEREO",0,0)==0);
    assert(snd_pcm_hw_params(target,&okay)==0);
    assert(snd_pcm_writei(target,audio,FRAMES)==FRAMES);
    assert(fabs(fake_alsa_rms()-baseline)<1e-5);
    mgu_cp_live_snapshot(&s);
    assert(s.target_open&&s.negotiated&&!s.armed);
    assert(s.processed_frames==0&&s.bypassed_frames==FRAMES);
    assert(mgu_cp_live_arm(&config)==0);
    assert(snd_pcm_writei(target,audio,FRAMES)==FRAMES);
    double filtered=fake_alsa_rms();
    assert(filtered>baseline*1.45&&filtered<baseline*2.2);
    assert(audio[0]==0&&audio[1]==0); /* caller PCM not mutated */
    assert(snd_pcm_writei(other,audio,FRAMES)==FRAMES);
    assert(fabs(fake_alsa_rms()-baseline)<1e-5);
    mgu_cp_live_snapshot(&s);
    assert(s.processed_frames==FRAMES&&s.armed);

    fake_alsa_partial(1);
    assert(snd_pcm_writei(target,audio,FRAMES)==FRAMES/2);
    fake_alsa_partial(0);
    mgu_cp_live_snapshot(&s);
    assert(s.processed_frames==FRAMES+FRAMES/2&&s.partial_writes==1);
    config.bands[0].gain_db=-6;
    assert(mgu_cp_live_reconfigure(&config)==0);
    assert(snd_pcm_writei(target,audio,FRAMES)==FRAMES);
    mgu_cp_live_disarm();
    assert(snd_pcm_writei(target,audio,FRAMES)==FRAMES);
    assert(fabs(fake_alsa_rms()-baseline)<1e-5);

    /* MMAP always forwards unmodified and disables this strict prototype. */
    assert(mgu_cp_live_arm(&config)==0);
    assert(snd_pcm_mmap_writei(target,audio,FRAMES)==FRAMES);
    mgu_cp_live_snapshot(&s);
    assert(s.mmap_writes==1&&!s.armed);
    assert(mgu_cp_live_arm(&config)!=0);
    assert(snd_pcm_close(target)==0);
    assert(snd_pcm_open(&target,"smartx:CarPlayMain_CF_48_STEREO",0,0)==0);
    assert(snd_pcm_hw_params(target,&wrong)==0);
    assert(mgu_cp_live_arm(&config)!=0);
    assert(snd_pcm_writei(target,audio,FRAMES)==FRAMES);
    assert(fabs(fake_alsa_rms()-baseline)<1e-5);
    assert(snd_pcm_close(target)==0);
    assert(snd_pcm_close(other)==0);
    puts("PASS: offline CarPlay exact-port live PCM DSP, default bypass, 48k S16LE stereo only, short-write recovery, MMAP rejection, rollback, isolated non-CarPlay audio");
    return 0;
}
