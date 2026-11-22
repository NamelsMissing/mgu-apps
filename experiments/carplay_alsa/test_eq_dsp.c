#include "eq_dsp.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static void bypass_test(void) {
    MguEqConfig c;
    MguEqDsp d;
    mgu_eq_defaults(&c);
    assert(mgu_eq_init(&d, 48000, 2, &c) == 0);
    const int16_t original[] = {-32768, 32767, 0, -10000, 12345, -32768};
    int16_t output[6] = {0};
    assert(mgu_eq_process_s16le(&d, original, output, 3) == 0);
    assert(memcmp(original, output, sizeof(output)) == 0);
    assert(d.frames_processed == 3 && d.clipped_samples == 0);
}

static void bypass_24bit_test(void) {
    MguEqConfig config;
    MguEqDsp dsp;
    mgu_eq_defaults(&config);
    const unsigned char original[] = {0xff, 0xff, 0x7f, 0x5a, 0x00, 0x00, 0x80, 0xa5};
    unsigned char output[sizeof original];
    const int formats[] = {MGU_EQ_S24_LE, MGU_EQ_S24_3LE};
    for (unsigned i = 0; i < sizeof formats / sizeof formats[0]; ++i) {
        assert(mgu_eq_init(&dsp, 48000, 2, &config) == 0);
        memset(output, 0, sizeof output);
        assert(mgu_eq_process(&dsp, formats[i], original, output, 1) == 0);
        assert(memcmp(original, output, 2 * mgu_eq_sample_bytes(formats[i])) == 0);
    }
    assert(mgu_eq_process(&dsp, 14, original, output, 1) != 0);
}

static double sine_test(unsigned rate, int gain_db, int auto_headroom) {
    MguEqConfig c;
    MguEqDsp d;
    mgu_eq_defaults(&c);
    c.enabled = 1;
    c.auto_headroom = auto_headroom;
    c.bands[3].gain_db = gain_db;
    assert(mgu_eq_init(&d, rate, 2, &c) == 0);
    double input_power = 0, output_power = 0;
    const unsigned count = rate;
    for (unsigned start = 0; start < count; start += 256) {
        const unsigned frames = count - start < 256 ? count - start : 256;
        int16_t input[512], output[512];
        for (unsigned j = 0; j < frames; ++j) {
            const double sample = 0.08 * sin(2 * M_PI * 1000 * (start + j) / rate);
            input[2 * j] = (int16_t)lround(sample * 32768);
            input[2 * j + 1] = 0;
        }
        assert(mgu_eq_process_s16le(&d, input, output, frames) == 0);
        for (unsigned j = 0; j < frames; ++j) {
            assert(output[2 * j + 1] == 0); // no L/R leakage
            if (start + j > rate / 10) {
                input_power += (double)input[2 * j] * input[2 * j];
                output_power += (double)output[2 * j] * output[2 * j];
            }
        }
    }
    assert(d.clipped_samples == 0 && d.frames_processed == count);
    return sqrt(output_power / input_power);
}

static void config_test(void) {
    MguEqConfig c;
    MguEqDsp d;
    mgu_eq_defaults(&c);
    assert(mgu_eq_init(&d, 48000, 1, &c) == 0);
    c.enabled = 1;
    c.bands[3].gain_db = 6;
    assert(mgu_eq_configure(&d, &c) == 0);
    assert(d.fading && d.fade_remaining == 1200);
    int16_t in[256] = {0}, out[256];
    for (int i = 0; i < 5; ++i) assert(mgu_eq_process_s16le(&d, in, out, 256) == 0);
    assert(!d.fading);
    c.bands[0].frequency_hz = 25000;
    assert(mgu_eq_configure(&d, &c) != 0);
}

static void benchmark(void) {
    enum { FRAMES = 4096, BLOCKS = 1000 };
    MguEqConfig config;
    MguEqDsp dsp;
    mgu_eq_defaults(&config);
    config.enabled = 1;
    for (int band = 0; band < MGU_EQ_BANDS; ++band) config.bands[band].gain_db = 3;
    assert(mgu_eq_init(&dsp, 48000, 2, &config) == 0);
    int16_t input[FRAMES * 2], output[FRAMES * 2];
    for (unsigned i = 0; i < FRAMES * 2; ++i) input[i] = (int16_t)(8000 * sin(i * 0.03));
    const clock_t start = clock();
    for (unsigned i = 0; i < BLOCKS; ++i)
        assert(mgu_eq_process_s16le(&dsp, input, output, FRAMES) == 0);
    const double us = (double)(clock() - start) * 1e6 / (CLOCKS_PER_SEC * (double)BLOCKS);
    printf("Host CPU mean %.1f us per %u-frame stereo block, DSP state %zu bytes\n", us, FRAMES, sizeof dsp);
}

int main(int argc, char **argv) {
    bypass_test();
    bypass_24bit_test();
    if (argc == 2 && !strcmp(argv[1], "--bench")) benchmark();
    config_test();
    const double boosted48 = sine_test(48000, 6, 0);
    const double boosted44 = sine_test(44100, 6, 0);
    const double protected48 = sine_test(48000, 6, 1);
    printf("1 kHz +6 dB at 48 kHz: x%.4f\n", boosted48);
    printf("1 kHz +6 dB at 44.1 kHz: x%.4f\n", boosted44);
    printf("1 kHz +6 dB with auto-headroom: x%.4f\n", protected48);
    assert(boosted48 > 1.93 && boosted48 < 2.06);
    assert(boosted44 > 1.93 && boosted44 < 2.06);
    assert(protected48 > 0.95 && protected48 < 1.06);
    puts("PASS: bypass, stereo isolation, transitions, validation, EQ response");
    return 0;
}
