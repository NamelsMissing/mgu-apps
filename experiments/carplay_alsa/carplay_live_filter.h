#ifndef MGU_CARPLAY_LIVE_FILTER_H
#define MGU_CARPLAY_LIVE_FILTER_H
#include <stdint.h>
#include "eq_dsp.h"
/* Offline-only test API. No system daemon, IPC or vehicle deployment. */
typedef struct {
    int target_open, negotiated, armed, format;
    unsigned channels, rate;
    uint64_t intercepted_writes, processed_frames, bypassed_frames;
    uint64_t mmap_writes, unsupported_calls, partial_writes;
} MguCarplayLiveStats;
void mgu_cp_live_snapshot(MguCarplayLiveStats *out);
int mgu_cp_live_arm(const MguEqConfig *config);
int mgu_cp_live_reconfigure(const MguEqConfig *config);
void mgu_cp_live_disarm(void);
#endif
