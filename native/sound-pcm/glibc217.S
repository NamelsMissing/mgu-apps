/*
 * Program entry without the build host's crt1.o: binds __libc_start_main and the dl* functions to
 * their oldest x86-64 versions (GLIBC_2.2.5), so the binary also runs on the MGU's older glibc.
 * No constructors are needed (plain C99, no static initialisers with code).
 */
    .symver __libc_start_main, __libc_start_main@GLIBC_2.2.5
    .symver dlopen, dlopen@GLIBC_2.2.5
    .symver dlsym, dlsym@GLIBC_2.2.5
    .symver dlerror, dlerror@GLIBC_2.2.5
    .symver dlclose, dlclose@GLIBC_2.2.5
    .text
    .globl _start
    .type _start, @function
_start:
    xor %ebp, %ebp
    mov %rdx, %r9               /* rtld_fini */
    pop %rsi                    /* argc */
    mov %rsp, %rdx              /* argv */
    and $-16, %rsp
    push %rax
    push %rsp                   /* stack_end */
    xor %r8d, %r8d              /* fini */
    xor %ecx, %ecx              /* init */
    lea main(%rip), %rdi
    call __libc_start_main@PLT
    hlt
    .section .note.GNU-stack,"",@progbits
