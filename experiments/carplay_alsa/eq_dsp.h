#ifndef MGU_EQ_DSP_H
#define MGU_EQ_DSP_H

#include <stddef.h>
#include <stdint.h>

#define MGU_EQ_BANDS 7
#define MGU_EQ_MAX_CHANNELS 2
#define MGU_EQ_HISTORY_FRAMES 2048

typedef struct {
    double frequency_hz;
    double gain_db;
    double q;
} MguEqBand;

typedef struct {
    int enabled;
    double preamp_db;
    int auto_headroom;
    MguEqBand bands[MGU_EQ_BANDS];
} MguEqConfig;

typedef struct {
    double b0, b1, b2, a1, a2;
} MguEqBiquad;

typedef struct {
    MguEqBiquad biquads[MGU_EQ_BANDS];
    double z1[MGU_EQ_MAX_CHANNELS][MGU_EQ_BANDS];
    double z2[MGU_EQ_MAX_CHANNELS][MGU_EQ_BANDS];
    double linear_gain;
    int enabled;
} MguEqBank;

typedef enum {
    MGU_EQ_S16_LE = 2,
    MGU_EQ_S24_LE = 6,      /* 24 significant bits in 32-bit storage */
    MGU_EQ_S24_3LE = 32     /* packed 24 bit */
} MguEqFormat;

typedef struct {
    unsigned sample_rate;
    unsigned channels;
    MguEqBank current;
    MguEqBank previous;
    MguEqConfig queued;
    int has_queued;
    int fading;
    unsigned fade_frames;
    unsigned fade_remaining;
    float history[MGU_EQ_HISTORY_FRAMES][MGU_EQ_MAX_CHANNELS];
    unsigned history_pos;
    unsigned history_count;
    uint64_t frames_processed;
    uint64_t clipped_samples;
    double peak_in;
    double peak_out;
} MguEqDsp;

void mgu_eq_defaults(MguEqConfig *config);
int mgu_eq_valid(const MguEqConfig *config, unsigned sample_rate);
double mgu_eq_headroom_db(const MguEqConfig *config);
int mgu_eq_init(MguEqDsp *dsp, unsigned sample_rate, unsigned channels, const MguEqConfig *config);
int mgu_eq_configure(MguEqDsp *dsp, const MguEqConfig *config);
unsigned mgu_eq_sample_bytes(int format);
int mgu_eq_process(MguEqDsp *dsp, int format, const void *in, void *out, size_t frames);
int mgu_eq_process_s16le(MguEqDsp *dsp, const int16_t *in, int16_t *out, size_t frames);

#endif
