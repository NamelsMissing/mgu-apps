CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -Werror
OUTPUT ?= mgu-gamestation-audio

$(OUTPUT): pcm_output.c
	$(CC) -std=c99 $(CFLAGS) -o $@ $< -ldl

.PHONY: dist
dist:
	zig cc -target x86_64-linux-gnu.2.17 -std=c99 -O2 -Wall -Wextra -Werror -s \
		-o mgu-gamestation-audio pcm_output.c -ldl
