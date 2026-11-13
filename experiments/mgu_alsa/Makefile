CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Werror
LDLIBS = -ldl -lm

all: mgu-audio-probe

mgu-audio-probe: mgu_audio_probe.c
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

check: mgu-audio-probe
	./mgu-audio-probe --help
	./mgu-audio-probe --status
	./mgu-audio-probe --hints
	./mgu-audio-probe --test-null

clean:
	rm -f mgu-audio-probe

.PHONY: all check clean
